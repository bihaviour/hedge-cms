import {
  buildEntryValidator,
  createEntrySchema,
  type Entry,
  type EntryMetadata,
  type EntryRevision,
  entryMetadataSchema,
  fieldsSchema,
  listEntriesQuerySchema,
  slugify,
  updateEntrySchema,
} from '@hedge/core'
import { and, asc, desc, eq, gt, like, lt, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import {
  type CollectionRow,
  type EntryRow,
  entries,
  entryRevisions,
  type SiteRow,
  users,
} from '../db/schema'
import type { Actor, AppEnv } from '../env'
import { requireActor, requireScope, requireSiteRole } from '../lib/auth'
import { findCollection } from '../lib/collections'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'

const app = new Hono<AppEnv>()

function toEntry(row: EntryRow, collection: CollectionRow): Entry {
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

function toEntryRevision(
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
async function snapshotRevision(db: ReturnType<typeof getDb>, entry: EntryRow, actor: Actor) {
  await db.insert(entryRevisions).values({
    id: newId('rev'),
    entryId: entry.id,
    data: entry.data,
    metadata: entry.metadata,
    status: entry.status,
    createdBy: actor.kind === 'user' ? actor.id : null,
  })
}

/** Validates `data` against the collection's field definitions. */
function validateData(collection: CollectionRow, data: Record<string, unknown>) {
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
function resolveMetadata(site: SiteRow, input: EntryMetadata | undefined): EntryMetadata {
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

app.get('/', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  const collection = await findCollection(c.env, requireSite(c).id, c.req.param('collection')!)
  const query = validateQuery(c, listEntriesQuerySchema)
  const db = getDb(c.env)

  const column = entries[query.sort]
  const filters: SQL[] = [eq(entries.collectionId, collection.id)]
  if (query.status) filters.push(eq(entries.status, query.status))
  if (query.visibility) filters.push(eq(entries.visibility, query.visibility))
  if (query.locale) filters.push(eq(entries.locale, query.locale))
  if (query.q) filters.push(like(entries.slug, `%${query.q}%`))
  // Keyset pagination: the cursor is the last row's sort value, which keeps deep pages cheap.
  if (query.cursor) {
    filters.push(query.order === 'desc' ? lt(column, query.cursor) : gt(column, query.cursor))
  }

  const rows = await db
    .select()
    .from(entries)
    .where(and(...filters))
    .orderBy(query.order === 'desc' ? desc(column) : asc(column))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  const last = page.at(-1)

  return c.json({
    data: page.map((row) => toEntry(row, collection)),
    nextCursor: hasMore && last ? String(last[query.sort] ?? '') : null,
  })
})

app.get('/:slug', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  const site = requireSite(c)
  const collection = await findCollection(c.env, site.id, c.req.param('collection')!)
  const db = getDb(c.env)
  const locale = c.req.query('locale') ?? site.defaultLocale

  const [row] = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.collectionId, collection.id),
        eq(entries.slug, c.req.param('slug')),
        eq(entries.locale, locale),
      ),
    )
    .limit(1)

  if (!row) throw ApiError.notFound('Entry')
  return c.json({ data: toEntry(row, collection) })
})

app.post('/', requireSiteRole('editor'), requireScope('content:write'), async (c) => {
  const site = requireSite(c)
  const collection = await findCollection(c.env, site.id, c.req.param('collection')!)
  const input = await validate(c, createEntrySchema)
  const actor = requireActor(c)
  const db = getDb(c.env)

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
      createdBy: actor.kind === 'user' ? actor.id : null,
      updatedBy: actor.kind === 'user' ? actor.id : null,
    })
    .returning()
    .catch((err: Error) => {
      if (err.message.includes('UNIQUE')) {
        throw ApiError.conflict(`An entry with slug "${slug}" already exists in this locale`)
      }
      throw err
    })

  return c.json({ data: toEntry(row!, collection) }, 201)
})

app.patch('/:slug', requireSiteRole('editor'), requireScope('content:write'), async (c) => {
  const site = requireSite(c)
  const collection = await findCollection(c.env, site.id, c.req.param('collection')!)
  const input = await validate(c, updateEntrySchema)
  const actor = requireActor(c)
  const db = getDb(c.env)
  const locale = c.req.query('locale') ?? site.defaultLocale

  const [existing] = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.collectionId, collection.id),
        eq(entries.slug, c.req.param('slug')),
        eq(entries.locale, locale),
      ),
    )
    .limit(1)

  if (!existing) throw ApiError.notFound('Entry')

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

  // Snapshot the pre-update state so edits are always recoverable.
  await snapshotRevision(db, existing, actor)

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
      updatedBy: actor.kind === 'user' ? actor.id : null,
      updatedAt: now,
    })
    .where(eq(entries.id, existing.id))
    .returning()

  return c.json({ data: toEntry(row!, collection) })
})

app.delete('/:slug', requireSiteRole('editor'), requireScope('content:write'), async (c) => {
  const site = requireSite(c)
  const collection = await findCollection(c.env, site.id, c.req.param('collection')!)
  const db = getDb(c.env)
  const locale = c.req.query('locale') ?? site.defaultLocale

  const result = await db
    .delete(entries)
    .where(
      and(
        eq(entries.collectionId, collection.id),
        eq(entries.slug, c.req.param('slug')),
        eq(entries.locale, locale),
      ),
    )
    .returning({ id: entries.id })

  if (result.length === 0) throw ApiError.notFound('Entry')
  return c.body(null, 204)
})

app.get('/:slug/revisions', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const collection = await findCollection(c.env, site.id, c.req.param('collection')!)
  const db = getDb(c.env)
  const locale = c.req.query('locale') ?? site.defaultLocale

  const [entry] = await db
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.collectionId, collection.id),
        eq(entries.slug, c.req.param('slug')),
        eq(entries.locale, locale),
      ),
    )
    .limit(1)

  if (!entry) throw ApiError.notFound('Entry')

  // Left join the author in — a bare `created_by` id would mean nothing in the revisions list, and
  // the join is on the users primary key, so it stays an indexed lookup rather than a scan.
  const rows = await db
    .select({ revision: entryRevisions, authorName: users.name })
    .from(entryRevisions)
    .leftJoin(users, eq(entryRevisions.createdBy, users.id))
    .where(eq(entryRevisions.entryId, entry.id))
    .orderBy(desc(entryRevisions.createdAt))
    .limit(50)

  return c.json({ data: rows.map((row) => toEntryRevision(row.revision, row.authorName)) })
})

app.post(
  '/:slug/revisions/:revisionId/restore',
  requireSiteRole('editor'),
  requireScope('content:write'),
  async (c) => {
    const site = requireSite(c)
    const collection = await findCollection(c.env, site.id, c.req.param('collection')!)
    const actor = requireActor(c)
    const db = getDb(c.env)
    const locale = c.req.query('locale') ?? site.defaultLocale

    const [existing] = await db
      .select()
      .from(entries)
      .where(
        and(
          eq(entries.collectionId, collection.id),
          eq(entries.slug, c.req.param('slug')),
          eq(entries.locale, locale),
        ),
      )
      .limit(1)

    if (!existing) throw ApiError.notFound('Entry')

    // Scope the revision lookup to this entry, so a revision id from another entry can't be
    // restored onto this one even if the caller can reach both.
    const [revision] = await db
      .select()
      .from(entryRevisions)
      .where(
        and(
          eq(entryRevisions.id, c.req.param('revisionId')!),
          eq(entryRevisions.entryId, existing.id),
        ),
      )
      .limit(1)

    if (!revision) throw ApiError.notFound('Revision')

    // Restoring is itself an edit: snapshot the current state first, so the restore is undoable too.
    await snapshotRevision(db, existing, actor)

    const status = revision.status as EntryRow['status']
    const now = new Date().toISOString()

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
        updatedBy: actor.kind === 'user' ? actor.id : null,
        updatedAt: now,
      })
      .where(eq(entries.id, existing.id))
      .returning()

    return c.json({ data: toEntry(row!, collection) })
  },
)

export default app
