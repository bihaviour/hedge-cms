import {
  buildEntryValidator,
  type CreateEntryInput,
  type Entry,
  type EntryMetadata,
  type EntryRevision,
  entryMetadataSchema,
  fieldsSchema,
  type ListEntriesQuery,
  slugify,
  type UpdateEntryInput,
} from '@hedge/core'
import { and, desc, eq, getTableColumns, like, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import {
  type CollectionRow,
  type EntryRow,
  entries,
  entryRevisions,
  type SiteRow,
  users,
} from '../db/schema'
import type { Bindings } from '../env'
import { findCollection } from './collections'
import {
  cursorCondition,
  decodeCursor,
  encodeCursor,
  orderByClause,
  parseEntryFilters,
  resolveSort,
  whereConditions,
} from './entry-query'
import { ApiError } from './errors'
import { newId } from './id'

/**
 * Columns the management list can sort by directly, on top of any declared field via `data.<field>`.
 * `createdAt` is here and not on the delivery API because the admin lists drafts, which have no
 * publish date to order by.
 */
const MANAGEMENT_SORT_COLUMNS = {
  createdAt: entries.createdAt,
  updatedAt: entries.updatedAt,
  publishedAt: entries.publishedAt,
  slug: entries.slug,
}

/**
 * Entry CRUD, factored out of the HTTP route so the REST API and the MCP endpoint drive exactly
 * the same logic — same field validation, same locale rules, same revision snapshots. Anything an
 * agent can do to an entry is therefore something the admin UI can do too, and vice versa.
 *
 * Every function takes the whole `SiteRow` rather than a bare id: the site owns the locale list a
 * new entry has to land inside, and the custom-field definitions its metadata is validated against.
 */

export function toEntry(row: EntryRow, collection: CollectionRow): Entry {
  return {
    id: row.id,
    collectionId: row.collectionId,
    collectionSlug: collection.slug,
    slug: row.slug,
    status: row.status,
    visibility: row.visibility,
    locale: row.locale,
    data: row.data,
    metadata: entryMetadataSchema.parse(row.metadata ?? {}),
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toEntryRevision(
  row: typeof entryRevisions.$inferSelect,
  authorName: string | null,
): EntryRevision {
  return {
    id: row.id,
    entryId: row.entryId,
    data: row.data,
    // Older rows have no metadata snapshot; surface that as null rather than empty defaults, so a
    // restore leaves the live entry's metadata alone instead of overwriting it with blanks.
    metadata: row.metadata ? entryMetadataSchema.parse(row.metadata) : null,
    status: row.status as EntryRevision['status'],
    createdBy: row.createdBy,
    createdByName: authorName,
    createdAt: row.createdAt,
  }
}

/**
 * Snapshot an entry's current state into `entry_revisions` before it is overwritten — the one place
 * that decides what a revision captures, so an update and a restore record the same thing.
 */
async function snapshotRevision(
  db: ReturnType<typeof getDb>,
  entry: EntryRow,
  actorId: string | null,
) {
  await db.insert(entryRevisions).values({
    id: newId('rev'),
    entryId: entry.id,
    data: entry.data,
    metadata: entry.metadata,
    status: entry.status,
    createdBy: actorId,
  })
}

/**
 * Refuses to publish through the ordinary write path when the collection requires approvals.
 *
 * This lives in the service rather than in the route because *both* surfaces go through here: the
 * REST `PATCH` and the MCP `update_entry` tool. A gate on the route alone would have a hole wide
 * enough to drive the entire MCP surface through. `viaApprovedVersion` is how `publishEntryVersion`
 * — the one path that has actually collected the approvals — comes back in.
 */
export function assertPublishAllowed(
  collection: CollectionRow,
  status: string,
  wasPublished: boolean,
  viaApprovedVersion: boolean,
) {
  if (status !== 'published' || wasPublished || viaApprovedVersion) return
  if (collection.approvalLevels === 0) return

  throw ApiError.approvalRequired(
    `"${collection.slug}" requires ${collection.approvalLevels} approval(s) before an entry can be published. ` +
      'Create a version, submit it for review, and publish that instead.',
  )
}

/** Validates `data` against the collection's field definitions. */
export function validateData(collection: CollectionRow, data: Record<string, unknown>) {
  const fields = fieldsSchema.parse(collection.fields)
  const result = buildEntryValidator(fields).safeParse(data)
  if (!result.success) throw ApiError.fromZod(result.error)
  return result.data
}

/**
 * Validates an entry's metadata: the SEO/social fields on their own, and its `custom` values
 * against the *site's* custom field definitions. Custom-field errors are keyed under
 * `metadata.<field>` so the admin can attach them to the right input without clashing with a
 * collection data field of the same name.
 */
export function resolveMetadata(site: SiteRow, input: EntryMetadata | undefined): EntryMetadata {
  const meta = entryMetadataSchema.parse(input ?? {})
  const customFields = fieldsSchema.parse(site.customFields ?? [])
  const result = buildEntryValidator(customFields).safeParse(meta.custom)
  if (!result.success) {
    const details: Record<string, string[]> = {}
    for (const issue of result.error.issues) {
      const key = `metadata.${issue.path.join('.') || '_'}`
      details[key] = [...(details[key] ?? []), issue.message]
    }
    throw ApiError.badRequest('Metadata validation failed', details)
  }
  return { ...meta, custom: result.data }
}

/** Locates one entry within a collection, in a single locale. Entries are keyed by both. */
export async function findEntry(
  env: Bindings,
  collection: CollectionRow,
  slug: string,
  locale: string,
): Promise<EntryRow> {
  const [row] = await getDb(env)
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.collectionId, collection.id),
        eq(entries.slug, slug),
        eq(entries.locale, locale),
      ),
    )
    .limit(1)

  if (!row) throw ApiError.notFound('Entry')
  return row
}

export async function listEntries(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  query: ListEntriesQuery,
  searchParams?: URLSearchParams,
): Promise<{ data: Entry[]; nextCursor: string | null }> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const fields = fieldsSchema.parse(collection.fields)
  const sort = resolveSort(query.sort, fields, MANAGEMENT_SORT_COLUMNS)

  const filters: SQL[] = [eq(entries.collectionId, collection.id)]
  if (query.status) filters.push(eq(entries.status, query.status))
  if (query.visibility) filters.push(eq(entries.visibility, query.visibility))
  if (query.locale) filters.push(eq(entries.locale, query.locale))
  if (query.q) filters.push(like(entries.slug, `%${query.q}%`))
  // `where[field][op]` filters live in the query string, not the parsed body, so they are read
  // straight off it here — only when the route passes it (the MCP list tool does not).
  if (searchParams) filters.push(...whereConditions(parseEntryFilters(searchParams, fields)))
  if (query.cursor) filters.push(cursorCondition(sort, query.order, decodeCursor(query.cursor)))

  // Select the sort expression alongside the row so the next cursor is the value actually ordered
  // by, whether that was a column or a `json_extract` of a declared field.
  const rows = await getDb(env)
    .select({ ...getTableColumns(entries), _sort: sort.expr })
    .from(entries)
    .where(and(...filters))
    .orderBy(...orderByClause(sort, query.order))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  const last = page.at(-1)

  return {
    data: page.map((row) => toEntry(row, collection)),
    nextCursor: hasMore && last ? encodeCursor(last._sort, last.id) : null,
  }
}

export async function getEntry(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  locale?: string,
): Promise<Entry> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const row = await findEntry(env, collection, slug, locale ?? site.defaultLocale)
  return toEntry(row, collection)
}

export async function createEntry(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  input: CreateEntryInput,
  actorId: string | null,
): Promise<Entry> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const db = getDb(env)

  // A new entry lands in the site's default locale unless one is named — and it can only land in a
  // locale the site actually publishes, so a typo does not create an orphan no delivery call finds.
  const locale = input.locale ?? site.defaultLocale
  if (!site.locales.includes(locale)) {
    throw ApiError.badRequest(`This site does not publish the "${locale}" locale`, {
      locale: [`enable "${locale}" in the site's localization settings first`],
    })
  }

  const data = validateData(collection, input.data)
  const metadata = resolveMetadata(site, input.metadata)
  const slug = input.slug ?? (slugify(String(data.title ?? '')) || newId())

  // Creating an entry already published would sidestep the workflow as completely as a `PATCH`
  // would — versions hang off an entry that exists, so the first save has to land as a draft.
  assertPublishAllowed(collection, input.status, false, false)

  if (collection.kind === 'single') {
    const [existing] = await db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.collectionId, collection.id))
      .limit(1)
    if (existing) throw ApiError.conflict('Single-entry collections can only hold one entry')
  }

  const now = new Date().toISOString()
  const [row] = await db
    .insert(entries)
    .values({
      id: newId('ent'),
      collectionId: collection.id,
      slug,
      status: input.status,
      visibility: input.visibility,
      locale,
      data,
      metadata,
      publishedAt: input.status === 'published' ? now : null,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning()
    .catch((err: Error) => {
      if (err.message.includes('UNIQUE')) {
        throw ApiError.conflict(`An entry with slug "${slug}" already exists in this locale`)
      }
      throw err
    })

  return toEntry(row!, collection)
}

export async function updateEntry(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  input: UpdateEntryInput,
  actorId: string | null,
  locale?: string,
  /**
   * Set only by `publishEntryVersion`, which has already collected every approval the collection
   * requires. Publishing through the version routes still lands here so the pre-publish state is
   * snapshotted as a revision and `publishedAt` keeps being decided in exactly one place.
   */
  options: { viaApprovedVersion?: boolean } = {},
): Promise<Entry> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const db = getDb(env)
  const existing = await findEntry(env, collection, slug, locale ?? site.defaultLocale)

  // Moving an entry to another locale is allowed, but only into one the site publishes.
  if (input.locale && !site.locales.includes(input.locale)) {
    throw ApiError.badRequest(`This site does not publish the "${input.locale}" locale`, {
      locale: [`enable "${input.locale}" in the site's localization settings first`],
    })
  }

  const data = input.data ? validateData(collection, input.data) : existing.data
  const metadata =
    input.metadata !== undefined ? resolveMetadata(site, input.metadata) : existing.metadata
  const status = input.status ?? existing.status
  const now = new Date().toISOString()

  assertPublishAllowed(
    collection,
    status,
    existing.status === 'published',
    options.viaApprovedVersion ?? false,
  )

  // Snapshot the pre-update state so edits are always recoverable.
  await snapshotRevision(db, existing, actorId)

  const [row] = await db
    .update(entries)
    .set({
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      status,
      data,
      metadata,
      publishedAt:
        status === 'published'
          ? (existing.publishedAt ?? now)
          : status === 'draft'
            ? null
            : existing.publishedAt,
      updatedBy: actorId,
      updatedAt: now,
    })
    .where(eq(entries.id, existing.id))
    .returning()

  return toEntry(row!, collection)
}

export async function deleteEntry(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  locale?: string,
): Promise<void> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const existing = await findEntry(env, collection, slug, locale ?? site.defaultLocale)
  await getDb(env).delete(entries).where(eq(entries.id, existing.id))
}

export async function listEntryRevisions(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  locale?: string,
): Promise<EntryRevision[]> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const entry = await findEntry(env, collection, slug, locale ?? site.defaultLocale)

  // Left join the author in — a bare `created_by` id would mean nothing in the revisions list, and
  // the join is on the users primary key, so it stays an indexed lookup rather than a scan.
  const rows = await getDb(env)
    .select({ revision: entryRevisions, authorName: users.name })
    .from(entryRevisions)
    .leftJoin(users, eq(entryRevisions.createdBy, users.id))
    .where(eq(entryRevisions.entryId, entry.id))
    .orderBy(desc(entryRevisions.createdAt))
    .limit(50)

  return rows.map((row) => toEntryRevision(row.revision, row.authorName))
}

export async function restoreEntryRevision(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  revisionId: string,
  actorId: string | null,
  locale?: string,
): Promise<Entry> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const db = getDb(env)
  const existing = await findEntry(env, collection, slug, locale ?? site.defaultLocale)

  // Scope the revision lookup to this entry, so a revision id from another entry can't be
  // restored onto this one even if the caller can reach both.
  const [revision] = await db
    .select()
    .from(entryRevisions)
    .where(and(eq(entryRevisions.id, revisionId), eq(entryRevisions.entryId, existing.id)))
    .limit(1)

  if (!revision) throw ApiError.notFound('Revision')

  const status = revision.status as EntryRow['status']
  const now = new Date().toISOString()

  // Rolling back to a revision that was published would publish a draft entry, which is the same
  // bypass by another door. Checked before the snapshot below, so a refused restore leaves no trace.
  assertPublishAllowed(collection, status, existing.status === 'published', false)

  // Restoring is itself an edit: snapshot the current state first, so the restore is undoable too.
  await snapshotRevision(db, existing, actorId)

  const [row] = await db
    .update(entries)
    .set({
      data: revision.data,
      // A revision predating metadata capture leaves the live metadata as it is.
      metadata: revision.metadata ?? existing.metadata,
      status,
      publishedAt:
        status === 'published'
          ? (existing.publishedAt ?? now)
          : status === 'draft'
            ? null
            : existing.publishedAt,
      updatedBy: actorId,
      updatedAt: now,
    })
    .where(eq(entries.id, existing.id))
    .returning()

  return toEntry(row!, collection)
}
