import {
  type AttachTranslationInput,
  buildEntryValidator,
  type CreateEntryInput,
  codeFields,
  type Entry,
  type EntryMetadata,
  type EntryRevision,
  type EntryTranslation,
  entryMetadataSchema,
  type Field,
  fieldsSchema,
  formatEntryCode,
  type ListEntriesQuery,
  parseEntryCode,
  slugify,
  type UpdateEntryInput,
} from '@hedge/core'
import { and, asc, desc, eq, getTableColumns, inArray, like, ne, type SQL, sql } from 'drizzle-orm'
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
  onePerTranslationGroup,
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

export function toEntry(
  row: EntryRow,
  collection: CollectionRow,
  translations?: EntryTranslation[],
): Entry {
  return {
    id: row.id,
    collectionId: row.collectionId,
    collectionSlug: collection.slug,
    translationGroupId: row.translationGroupId,
    slug: row.slug,
    status: row.status,
    visibility: row.visibility,
    locale: row.locale,
    data: row.data,
    metadata: entryMetadataSchema.parse(row.metadata ?? {}),
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(translations ? { translations } : {}),
  }
}

/** A variant summarised for the list of its post's languages. */
export function toEntryTranslation(row: EntryRow): EntryTranslation {
  return {
    id: row.id,
    locale: row.locale,
    slug: row.slug,
    // The one `data` value the summary carries, because a list of languages with no titles in it is
    // a list of locale codes. Anything but a string reads as "no title" rather than being coerced.
    title: typeof row.data.title === 'string' ? row.data.title : null,
    status: row.status,
    publishedAt: row.publishedAt,
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

/**
 * Fills in every `code` field the collection declares, and refuses to let a caller set one.
 *
 * A code is the CMS's own identifier for a piece — `RB-0007` — so it is assigned once, when the
 * entry is first created, and then never moves. Three rules follow from that, and all three live
 * here rather than in a route so the REST API, the MCP tools and the version routes get the same
 * answer:
 *
 * - **The incoming value is discarded, always.** Not rejected — a client that round-trips an entry
 *   would then be unable to save it back. The stored value simply wins.
 * - **An existing entry keeps the code it has**, whatever the update says, including an update that
 *   renames the slug. An entry that predates the field being declared gets one on its next write.
 * - **A translation shares its siblings' code.** The code names the *piece*, and a piece is a
 *   translation group — so the Indonesian version of an article carries the same identifier as the
 *   English one. This used to be keyed on the slug, which worked only while every language of a
 *   post was forced to share one. Now that a translation can have a URL in its own language,
 *   `halo-dunia` and `hello-world` are the same piece and the group is what says so.
 *
 * The sequence is `max + 1` over the codes already issued in this collection, which cannot collide
 * with anything stored. Two creates racing in separate isolates can still both read the same max —
 * D1 has no transaction to hold across the two statements — so a duplicate is possible under
 * genuinely simultaneous authoring. Nothing downstream treats a code as unique.
 */
export async function applyGeneratedCodes(
  env: Bindings,
  collection: CollectionRow,
  data: Record<string, unknown>,
  translationGroupId: string,
  existing?: EntryRow,
): Promise<Record<string, unknown>> {
  const fields = codeFields(fieldsSchema.parse(collection.fields))
  if (fields.length === 0) return data

  // One lookup for every code field: another language of this same post, if there is one. On an
  // update the entry itself is the source, so the query only runs when creating.
  const sibling = existing ?? (await findGroupSibling(env, translationGroupId))
  const next: Record<string, unknown> = { ...data }

  for (const field of fields) {
    const carried = sibling?.data[field.name]
    if (typeof carried === 'string' && carried) {
      next[field.name] = carried
      continue
    }
    next[field.name] = formatEntryCode(field, await nextCodeSequence(env, collection, field))
  }

  return next
}

/** Any language of this post — the entry a new translation inherits its code from. */
async function findGroupSibling(
  env: Bindings,
  translationGroupId: string,
): Promise<EntryRow | undefined> {
  const [row] = await getDb(env)
    .select()
    .from(entries)
    .where(eq(entries.translationGroupId, translationGroupId))
    .limit(1)
  return row
}

/** Every language of one post, oldest variant first. */
async function groupVariants(env: Bindings, translationGroupId: string): Promise<EntryRow[]> {
  return getDb(env)
    .select()
    .from(entries)
    .where(eq(entries.translationGroupId, translationGroupId))
    .orderBy(asc(entries.id))
}

/**
 * The post a slug belongs to, in whichever language that slug happens to be written.
 *
 * A slug identifies a post across the whole collection, not just within one locale — otherwise
 * `GET /content/posts/halo-dunia?locale=en` would have no single post to resolve, and the fallback
 * it exists to serve would be ambiguous. So this doubles as the uniqueness check below.
 */
async function findGroupIdBySlug(
  env: Bindings,
  collection: CollectionRow,
  slug: string,
): Promise<string | undefined> {
  const [row] = await getDb(env)
    .select({ translationGroupId: entries.translationGroupId })
    .from(entries)
    .where(and(eq(entries.collectionId, collection.id), eq(entries.slug, slug)))
    .limit(1)
  return row?.translationGroupId
}

/**
 * Refuses a slug that already belongs to a *different* post. Within one post a slug may repeat
 * across languages — that is every deployment that predates per-locale slugs, and the unique index
 * on (collection, slug, locale) is what keeps those honest.
 */
async function assertSlugFree(
  env: Bindings,
  collection: CollectionRow,
  slug: string,
  translationGroupId: string,
) {
  const owner = await findGroupIdBySlug(env, collection, slug)
  if (owner && owner !== translationGroupId) {
    throw ApiError.conflict(
      `The slug "${slug}" already belongs to another entry in "${collection.slug}"`,
    )
  }
}

/**
 * One past the highest sequence issued in this collection for this field.
 *
 * Ordering by length before value is what makes a plain string comparison agree with a numeric one
 * once the count outgrows the padding — `RB-10000` sorts below `RB-9999` lexicographically and above
 * it by length. A short window rather than one row because a code left behind by an earlier prefix
 * sorts high and parses to nothing; taking the best of twenty skips past those without reading the
 * whole collection.
 */
async function nextCodeSequence(
  env: Bindings,
  collection: CollectionRow,
  field: Extract<Field, { kind: 'code' }>,
): Promise<number> {
  const code = sql<string>`json_extract(${entries.data}, ${`$.${field.name}`})`
  const rows = await getDb(env)
    .select({ code })
    .from(entries)
    .where(and(eq(entries.collectionId, collection.id), sql`${code} IS NOT NULL`))
    .orderBy(sql`length(${code}) desc`, sql`${code} desc`)
    .limit(20)

  const highest = rows.reduce((max, row) => Math.max(max, parseEntryCode(field, row.code) ?? 0), 0)
  return highest + 1
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
  // One row per *post* rather than per translation, so the admin's list of a multilingual
  // collection reads as the pieces that exist instead of the same article three times. The locale
  // filter still narrows first, so `groupBy=post&locale=id` is "the posts that have an Indonesian
  // variant" — a filter, not a fallback. Nothing here is published-only: this is the management
  // list, and a post whose only variant is a draft is exactly what an editor is looking for.
  if (query.groupBy === 'post') {
    filters.push(onePerTranslationGroup(query.locale ?? site.defaultLocale, site.defaultLocale))
  }
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

  // Only the grouped list needs the other languages, and it gets them in one query for the whole
  // page rather than one per row — the same shape the delivery API resolves media with.
  const translations =
    query.groupBy === 'post'
      ? await loadTranslations(
          env,
          page.map((row) => row.translationGroupId),
        )
      : null

  return {
    data: page.map((row) =>
      toEntry(row, collection, translations?.get(row.translationGroupId) ?? undefined),
    ),
    nextCursor: hasMore && last ? encodeCursor(last._sort, last.id) : null,
  }
}

/** D1 is SQLite: a query's parameters are bounded, so a large page is asked for in batches. */
const GROUP_BATCH = 90

/** Every language of every post on a page, keyed by group — one query per batch, not per row. */
export async function loadTranslations(
  env: Bindings,
  groupIds: string[],
): Promise<Map<string, EntryTranslation[]>> {
  const byGroup = new Map<string, EntryTranslation[]>()
  const unique = [...new Set(groupIds)]
  if (unique.length === 0) return byGroup

  const db = getDb(env)
  for (let i = 0; i < unique.length; i += GROUP_BATCH) {
    const rows = await db
      .select()
      .from(entries)
      .where(inArray(entries.translationGroupId, unique.slice(i, i + GROUP_BATCH)))
      .orderBy(asc(entries.locale))
    for (const row of rows) {
      const list = byGroup.get(row.translationGroupId) ?? []
      list.push(toEntryTranslation(row))
      byGroup.set(row.translationGroupId, list)
    }
  }

  return byGroup
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
  // Reading one entry carries its other languages: this is what the editor's locale switcher is
  // built from, and it cannot be derived from the slug any more — a sibling may have its own.
  const variants = await groupVariants(env, row.translationGroupId)
  return toEntry(row, collection, variants.map(toEntryTranslation))
}

/**
 * Which post a new entry belongs to.
 *
 * The explicit `translationOf` is the way to say it, but the slug fallback below is what keeps every
 * deployment that predates this column working: creating an entry with a slug another language
 * already uses has always meant "this is that piece, in another language", and the admin's
 * translation flow still relies on it. So it stays the rule when nothing says otherwise.
 */
async function resolveTranslationGroup(
  env: Bindings,
  collection: CollectionRow,
  slug: string,
  translationOf: string | undefined,
): Promise<string> {
  if (translationOf) {
    const group = await findGroupIdBySlug(env, collection, translationOf)
    if (!group) throw ApiError.notFound('Entry')
    return group
  }
  return (await findGroupIdBySlug(env, collection, slug)) ?? newId('tgr')
}

/** Refuses a second variant in a language the post already has — one post, one row per language. */
async function assertLocaleFree(env: Bindings, translationGroupId: string, locale: string) {
  const [clash] = await getDb(env)
    .select({ slug: entries.slug })
    .from(entries)
    .where(and(eq(entries.translationGroupId, translationGroupId), eq(entries.locale, locale)))
    .limit(1)

  if (clash) {
    throw ApiError.conflict(`This entry already has a "${locale}" version, at "${clash.slug}"`)
  }
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

  // The slug is settled before the group is resolved, and the group before validation: a `code`
  // field's value depends on which post this is, because a new translation inherits that piece's
  // identifier rather than taking a new one.
  const slug = input.slug ?? (slugify(String(input.data.title ?? '')) || newId())
  const translationGroupId = await resolveTranslationGroup(
    env,
    collection,
    slug,
    input.translationOf,
  )

  // Both halves of "one post, one row per language, and a slug names one post".
  await assertLocaleFree(env, translationGroupId, locale)
  await assertSlugFree(env, collection, slug, translationGroupId)

  const data = validateData(
    collection,
    await applyGeneratedCodes(env, collection, input.data, translationGroupId),
  )
  const metadata = resolveMetadata(site, input.metadata)

  // Creating an entry already published would sidestep the workflow as completely as a `PATCH`
  // would — versions hang off an entry that exists, so the first save has to land as a draft.
  assertPublishAllowed(collection, input.status, false, false)

  if (collection.kind === 'single') {
    // One *post*, not one row: a single-entry collection on a multilingual site still needs its
    // page in every language. Scoped to another group, so translating the one entry is allowed and
    // creating a second entry beside it is not.
    const [existing] = await db
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(
          eq(entries.collectionId, collection.id),
          ne(entries.translationGroupId, translationGroupId),
        ),
      )
      .limit(1)
    if (existing) throw ApiError.conflict('Single-entry collections can only hold one entry')
  }

  const now = new Date().toISOString()
  const [row] = await db
    .insert(entries)
    .values({
      id: newId('ent'),
      collectionId: collection.id,
      translationGroupId,
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

  // Relabelling this variant's language cannot collide with a language the post already has. The
  // unique index would catch the (slug, locale) case on its own, but not two different slugs in one
  // post claiming the same language — and that is the shape a post is not allowed to be in.
  if (input.locale && input.locale !== existing.locale) {
    await assertLocaleFree(env, existing.translationGroupId, input.locale)
  }
  // A rename may not take a slug that names a different post.
  if (input.slug && input.slug !== existing.slug) {
    await assertSlugFree(env, collection, input.slug, existing.translationGroupId)
  }

  const data = input.data
    ? validateData(
        collection,
        await applyGeneratedCodes(
          env,
          collection,
          input.data,
          existing.translationGroupId,
          existing,
        ),
      )
    : existing.data
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
    // The checks above catch a rename onto another post and a language this post already has. This
    // is the case they cannot see: two *different* posts in this collection each already holding a
    // variant at the incoming (slug, locale), which is the unique index's to refuse. Left as a raw
    // D1 error it surfaced as a 500 on what is an ordinary editing mistake.
    .catch((err: Error) => {
      if (err.message.includes('UNIQUE')) {
        throw ApiError.conflict(
          `An entry with slug "${input.slug ?? existing.slug}" already exists in this locale`,
        )
      }
      throw err
    })

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
      // Restoring rolls the content back, never the identifier: a revision taken before the `code`
      // field was declared carries none, and rolling one back would otherwise reissue the piece.
      data: await applyGeneratedCodes(
        env,
        collection,
        revision.data,
        existing.translationGroupId,
        existing,
      ),
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

/**
 * Merging and splitting posts.
 *
 * A post is a set of `entries` rows sharing a `translationGroupId`, and these two functions are the
 * only things that move a row between sets. Everything else treats the group as given.
 *
 * The reason they exist: before the group column, the only way to say "these are the same piece in
 * two languages" was to give them the same slug, so anyone who wanted `/id/halo-dunia` rather than
 * `/id/hello-world` had to author genuinely separate posts. `attachTranslation` is the repair for
 * those, and it is a repair rather than a migration because only a person knows which two posts are
 * the same piece.
 */

/**
 * Every language of the post this slug names.
 *
 * Takes no locale, and that is the point: the admin asks this *while looking at a language the post
 * does not have yet* — following a link to `?locale=id` when only the English copy exists — so a
 * lookup keyed on (slug, locale) would 404 exactly when the answer is most needed. A slug names one
 * post whichever of its languages it is written in, which is what makes the locale unnecessary.
 */
export async function listTranslations(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
): Promise<EntryTranslation[]> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const group = await findGroupIdBySlug(env, collection, slug)
  if (!group) throw ApiError.notFound('Entry')
  return (await groupVariants(env, group)).map(toEntryTranslation)
}

/**
 * Pulls an existing entry — and every language *it* already has — into the addressed post.
 *
 * Three things are load-bearing:
 *
 * - **The two posts must not share a language.** A post holds one row per language, and there is no
 *   answer to which of two Indonesian variants wins. Refused with both slugs named, because the
 *   caller is looking at one of them and needs to be told about the other.
 * - **It merges whole posts, not rows.** Attaching a piece that is itself already a pair brings the
 *   pair. Anything else would silently strand the variant that was left behind.
 * - **The joined rows adopt this post's `code`.** A code names the piece, the pieces are becoming
 *   one, and the addressed post is the one the caller is keeping. Slugs, statuses, revisions and
 *   versions all stay exactly as they were: a merge changes what these rows *belong to*, never what
 *   they say, so nothing published changes and no URL moves.
 */
export async function attachTranslation(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  input: AttachTranslationInput,
): Promise<EntryTranslation[]> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const db = getDb(env)

  // Both by slug alone: this merges whole posts, so which language either slug is written in makes
  // no difference to which posts they are.
  const targetGroup = await findGroupIdBySlug(env, collection, slug)
  const incomingGroup = await findGroupIdBySlug(env, collection, input.slug)
  if (!targetGroup || !incomingGroup) throw ApiError.notFound('Entry')

  // Idempotent: linking something already linked is the state the caller asked for, and a second
  // click on a slow response should not be an error.
  if (incomingGroup === targetGroup) {
    return (await groupVariants(env, targetGroup)).map(toEntryTranslation)
  }

  const existing = await groupVariants(env, targetGroup)
  const joining = await groupVariants(env, incomingGroup)

  const taken = new Set(existing.map((row) => row.locale))
  const clash = joining.find((row) => taken.has(row.locale))
  if (clash) {
    throw ApiError.conflict(
      `Both entries already have a "${clash.locale}" version — "${slug}" and "${clash.slug}". ` +
        'A piece holds one version per language, so delete or re-language one of them first.',
    )
  }

  // The code the merged post keeps, read off the variant the caller addressed rather than
  // recomputed: `applyGeneratedCodes` would only reissue what this post already carries.
  const fields = codeFields(fieldsSchema.parse(collection.fields))
  const carried: Record<string, unknown> = {}
  for (const field of fields) {
    const value = existing.find((row) => typeof row.data[field.name] === 'string')?.data[field.name]
    if (typeof value === 'string' && value) carried[field.name] = value
  }

  const now = new Date().toISOString()
  for (const row of joining) {
    await db
      .update(entries)
      .set({
        translationGroupId: targetGroup,
        // Untouched when the collection declares no code field, so `data` is not rewritten for the
        // sake of it — the merge is a relationship change and should read as one in the revisions.
        ...(Object.keys(carried).length > 0 ? { data: { ...row.data, ...carried } } : {}),
        updatedAt: now,
      })
      .where(eq(entries.id, row.id))
  }

  return (await groupVariants(env, targetGroup)).map(toEntryTranslation)
}

/**
 * Splits one language out into a post of its own — the undo for a link, and the way to say "this
 * was never a translation of that".
 *
 * It keeps its `code`. A code is assigned once and never moves, which is the rule everywhere else
 * in this file, and an identifier that changed when an editor corrected a link would be worse than
 * two pieces sharing one. Nothing downstream treats a code as unique.
 */
export async function detachTranslation(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  locale?: string,
): Promise<Entry> {
  const collection = await findCollection(env, site.id, collectionSlug)
  const entry = await findEntry(env, collection, slug, locale ?? site.defaultLocale)
  const variants = await groupVariants(env, entry.translationGroupId)

  // Already a post of its own. Idempotent for the same reason attaching is.
  if (variants.length <= 1) return toEntry(entry, collection, variants.map(toEntryTranslation))

  const [row] = await getDb(env)
    .update(entries)
    .set({ translationGroupId: newId('tgr'), updatedAt: new Date().toISOString() })
    .where(eq(entries.id, entry.id))
    .returning()

  return toEntry(row!, collection, [toEntryTranslation(row!)])
}
