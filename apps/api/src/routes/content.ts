import {
  type EntryMetadata,
  type EntryVisibility,
  entryMetadataSchema,
  type Field,
  fieldsSchema,
  localeCodeSchema,
  MEMBER_TOKEN_HEADER,
  PREVIEW_TOKEN_HEADER,
  type SiteMetadata,
  siteMetadataSchema,
} from '@hedge/core'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { collections, entries, media } from '../db/schema'
import type { AppEnv, Bindings } from '../env'
import { requireScope, requireSiteRole } from '../lib/auth'
import {
  cursorCondition,
  decodeCursor,
  encodeCursor,
  orderByClause,
  parseEntryFilters,
  resolveSort,
  whereConditions,
} from '../lib/entry-query'
import { ApiError } from '../lib/errors'
import {
  absoluteMediaUrl,
  collectMediaKeys,
  type MediaLookup,
  mediaFieldsOf,
  type ResolvedMediaFields,
  resolveMediaFields,
} from '../lib/media-fields'
import { previewFor } from '../lib/preview'
import { requireSite } from '../lib/site'
import { validateQuery } from '../lib/validate'

/**
 * Read-only delivery API. Only published entries of the calling key's site are visible, and
 * responses carry a long `s-maxage` so Cloudflare's cache absorbs the traffic — the origin
 * Worker only runs on miss.
 *
 * Entries marked `members` are withheld unless the request also carries a member token for the
 * same site. Any response shaped by a member token is `private, no-store`: gated content must
 * never land in a shared cache where the next anonymous reader would be handed it.
 *
 * The single-entry handler is also where a **preview token** is honoured (`lib/preview.ts`): a
 * signed, short-lived token naming one entry lifts the published-only filter for that entry alone,
 * so a website can render a draft in its real layout. The list handler deliberately does not honour
 * one — preview is a single-page act, and a list that leaked drafts would be exactly the site-wide
 * exposure the token's per-entry scoping exists to prevent.
 */
const app = new Hono<AppEnv>()

const PUBLIC_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'
/** Used for anything a member token or a preview token shaped — neither may be shared. */
const PRIVATE_CACHE_CONTROL = 'private, no-store'

const listQuery = z.object({
  // Optional, not defaulted: when omitted the site's own `defaultLocale` is used, so an
  // Indonesian-first site serves Indonesian to a caller that names no locale.
  locale: localeCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  // A built-in column or a declared content field via `data.<field>` / `field:<field>`; resolved
  // against the collection below so a site can order by a `date` field it owns, not just publishing
  // timestamps. `where[field][op]` filters are read straight off the query string.
  sort: z.string().max(96).default('publishedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

/** Columns the delivery API can sort by directly, on top of any declared field via `data.<field>`. */
const DELIVERY_SORT_COLUMNS = {
  publishedAt: entries.publishedAt,
  updatedAt: entries.updatedAt,
  slug: entries.slug,
}

const DELIVERY_COLUMNS = {
  slug: entries.slug,
  locale: entries.locale,
  visibility: entries.visibility,
  data: entries.data,
  metadata: entries.metadata,
  publishedAt: entries.publishedAt,
  updatedAt: entries.updatedAt,
}

interface DeliveryRow {
  slug: string
  locale: string
  visibility: EntryVisibility
  data: Record<string, unknown>
  metadata: Record<string, unknown> | null
  publishedAt: string | null
  updatedAt: string
}

/** Apply a site's title template to an entry title — `"%s · Docs"` + `"Routing"` → `"Routing · Docs"`. */
function applyTitleTemplate(template: string | undefined, title: string | undefined) {
  if (!title) return undefined
  return template ? template.replace(/%s/g, title) : title
}

/**
 * The metadata a frontend renders for one entry: the entry's own SEO/social overrides falling back
 * to the site's defaults, its custom field values, and the site's own custom pairs. Resolved here so
 * a delivery client gets a ready-to-use head without a second request or any merge logic of its own.
 */
function resolveDeliveryMetadata(
  siteMeta: SiteMetadata,
  entryMeta: EntryMetadata,
  data: Record<string, unknown>,
  publicUrl: string,
  websiteUrl: string | null,
) {
  const title = typeof data.title === 'string' ? data.title : undefined
  return {
    title:
      entryMeta.metaTitle ??
      applyTitleTemplate(siteMeta.titleTemplate, title) ??
      siteMeta.metaTitle,
    description: entryMeta.description ?? siteMeta.description,
    canonicalUrl: entryMeta.canonicalUrl,
    // Absolute, always: this lands in `<meta property="og:image">`, where a relative value is
    // invalid and fails silently in every social preview. See `absoluteMediaUrl`.
    ogImage: absoluteMediaUrl(entryMeta.ogImage ?? siteMeta.ogImage, publicUrl, websiteUrl),
    keywords: siteMeta.keywords,
    twitterHandle: siteMeta.twitterHandle,
    noIndex: entryMeta.noIndex,
    custom: entryMeta.custom,
    siteCustom: siteMeta.custom,
  }
}

/**
 * Responses differ by member token and by preview token, so say so — and when either shaped the
 * answer, keep it out of shared caches entirely rather than trusting every hop in front of us to
 * honour `Vary`. A preview is per-token, short-lived and shows unpublished content: there is no
 * `s-maxage` that would be correct for it.
 */
function setCacheHeaders(c: Context<AppEnv>, personal: boolean) {
  c.header('vary', `${MEMBER_TOKEN_HEADER}, ${PREVIEW_TOKEN_HEADER}`)
  c.header('cache-control', personal ? PRIVATE_CACHE_CONTROL : PUBLIC_CACHE_CONTROL)
}

/**
 * Drops `data` from anything the caller has not unlocked, so a teaser can still be rendered.
 * Metadata is kept even when locked — a paywalled page still needs its title, description and
 * social tags to be indexed and to render in a link preview.
 */
function toDelivery(
  row: DeliveryRow,
  isMember: boolean,
  siteMeta: SiteMetadata,
  publicUrl: string,
  websiteUrl: string | null,
  resolved?: ResolvedMediaFields,
) {
  const locked = row.visibility === 'members' && !isMember
  const entryMeta = entryMetadataSchema.parse(row.metadata ?? {})
  return {
    slug: row.slug,
    locale: row.locale,
    visibility: row.visibility,
    locked,
    ...(locked ? {} : { data: row.data }),
    // A sibling of `data`, present only for collections that declare a media field — so the
    // payload of a collection without one is byte-for-byte what it was. Withheld along with
    // `data` when the entry is locked; a resolved URL is still the content. Metadata is not,
    // deliberately: a paywalled page still needs its social tags.
    ...(locked || !resolved ? {} : { media: resolved }),
    metadata: resolveDeliveryMetadata(siteMeta, entryMeta, row.data, publicUrl, websiteUrl),
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  }
}

/** D1 is SQLite: a query's parameters are bounded, so a large page is asked for in batches. */
const KEY_BATCH = 90

/**
 * One lookup for a whole page of entries, keyed by R2 object key. Skipped entirely — no query at
 * all — when the collection declares no media fields or none of its entries filled one in.
 */
async function loadMediaRows(
  env: Bindings,
  siteId: string,
  keys: string[],
): Promise<Map<string, MediaLookup>> {
  const rows = new Map<string, MediaLookup>()
  if (keys.length === 0) return rows

  const db = getDb(env)
  for (let i = 0; i < keys.length; i += KEY_BATCH) {
    const batch = keys.slice(i, i + KEY_BATCH)
    const found = await db
      .select({ key: media.key, alt: media.alt, width: media.width, height: media.height })
      .from(media)
      // The tenant filter matters as much here as anywhere: a key is only this site's to resolve.
      .where(and(eq(media.siteId, siteId), inArray(media.key, batch)))
    for (const row of found) rows.set(row.key, row)
  }

  return rows
}

/**
 * Resolves the media fields of every row in a page, positionally. Returns null — and runs no
 * query — for a collection that declares no media field.
 */
async function resolvePageMedia(
  env: Bindings,
  siteId: string,
  fields: Field[],
  datas: Record<string, unknown>[],
  websiteUrl: string | null,
): Promise<ResolvedMediaFields[] | null> {
  if (mediaFieldsOf(fields).length === 0) return null

  const rows = await loadMediaRows(env, siteId, collectMediaKeys(fields, datas))
  return datas.map((data) => resolveMediaFields(fields, data, rows, env.PUBLIC_URL, websiteUrl))
}

// A user browsing the delivery API still needs to be able to see the site it belongs to.
app.use('*', requireSiteRole('viewer'))
app.use('*', requireScope('content:read'))

app.get('/:collection', async (c) => {
  const site = requireSite(c)
  const query = validateQuery(c, listQuery)
  const db = getDb(c.env)
  const isMember = c.get('member') !== null

  const [collection] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.siteId, site.id), eq(collections.slug, c.req.param('collection'))))
    .limit(1)
  if (!collection) throw ApiError.notFound('Collection')

  const fields = fieldsSchema.parse(collection.fields)
  const sort = resolveSort(query.sort, fields, DELIVERY_SORT_COLUMNS)

  const filters: SQL[] = [
    eq(entries.collectionId, collection.id),
    eq(entries.status, 'published'),
    eq(entries.locale, query.locale ?? site.defaultLocale),
    ...whereConditions(parseEntryFilters(new URL(c.req.url).searchParams, fields)),
  ]
  if (query.cursor) filters.push(cursorCondition(sort, query.order, decodeCursor(query.cursor)))

  const rows = await db
    .select({ ...DELIVERY_COLUMNS, id: entries.id, _sort: sort.expr })
    .from(entries)
    .where(and(...filters))
    .orderBy(...orderByClause(sort, query.order))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  const last = page.at(-1)
  const siteMeta = siteMetadataSchema.parse(site.metadata ?? {})

  // A locked row contributes no data to resolve — its keys are content the caller has not bought.
  const resolved = await resolvePageMedia(
    c.env,
    site.id,
    fields,
    page.map((row) => (row.visibility === 'members' && !isMember ? {} : row.data)),
    site.previewUrl,
  )

  setCacheHeaders(c, isMember)
  return c.json({
    data: page.map((row, index) =>
      toDelivery(row, isMember, siteMeta, c.env.PUBLIC_URL, site.previewUrl, resolved?.[index]),
    ),
    nextCursor: hasMore && last ? encodeCursor(last._sort, last.id) : null,
  })
})

/** Field definitions for a collection — lets clients generate types or render forms. */
app.get('/:collection/_schema', async (c) => {
  const site = requireSite(c)
  const [collection] = await getDb(c.env)
    .select()
    .from(collections)
    .where(and(eq(collections.siteId, site.id), eq(collections.slug, c.req.param('collection'))))
    .limit(1)
  if (!collection) throw ApiError.notFound('Collection')

  c.header('cache-control', PUBLIC_CACHE_CONTROL)
  return c.json({
    data: {
      slug: collection.slug,
      name: collection.name,
      kind: collection.kind,
      fields: fieldsSchema.parse(collection.fields),
    },
  })
})

app.get('/:collection/:slug', async (c) => {
  const site = requireSite(c)
  const collectionSlug = c.req.param('collection')
  const slug = c.req.param('slug')
  const locale = c.req.query('locale') ?? site.defaultLocale
  const isMember = c.get('member') !== null

  // Only a token minted for *this* collection, slug and locale counts. Anything else — including a
  // valid token for the entry next door — leaves the published-only view exactly as it was.
  const preview = previewFor(c, collectionSlug, slug, locale)

  const [row] = await getDb(c.env)
    // The collection's fields come along for the ride: resolving media needs to know which of
    // this entry's values are keys, and the join is already here.
    .select({ ...DELIVERY_COLUMNS, fields: collections.fields })
    .from(entries)
    .innerJoin(collections, eq(collections.id, entries.collectionId))
    .where(
      and(
        eq(collections.siteId, site.id),
        eq(collections.slug, collectionSlug),
        eq(entries.slug, slug),
        eq(entries.locale, locale),
        // The one filter a preview lifts: draft and archived rows become readable, for this entry.
        ...(preview ? [] : [eq(entries.status, 'published')]),
      ),
    )
    .limit(1)

  if (!row) throw ApiError.notFound('Entry')

  // A preview token unlocks `members` content too: the previewer is a CMS user looking at an
  // article on their own site, and being shown a paywall instead of the page is not a preview.
  const unlocked = isMember || preview !== null

  // 403 rather than 404: the entry exists, and the site needs to know to render its paywall.
  if (row.visibility === 'members' && !unlocked) {
    throw ApiError.forbidden('This entry is for members only')
  }

  const siteMeta = siteMetadataSchema.parse(site.metadata ?? {})
  const resolved = await resolvePageMedia(
    c.env,
    site.id,
    fieldsSchema.parse(row.fields),
    [row.data],
    site.previewUrl,
  )

  setCacheHeaders(c, unlocked)
  return c.json({
    data: toDelivery(row, unlocked, siteMeta, c.env.PUBLIC_URL, site.previewUrl, resolved?.[0]),
  })
})

export default app
