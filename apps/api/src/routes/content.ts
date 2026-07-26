import {
  type EntryMetadata,
  type EntryVisibility,
  entryMetadataSchema,
  fieldsSchema,
  localeCodeSchema,
  MEMBER_TOKEN_HEADER,
  type SiteMetadata,
  siteMetadataSchema,
} from '@hedge/core'
import { and, asc, desc, eq, gt, lt, type SQL } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { collections, entries } from '../db/schema'
import type { AppEnv } from '../env'
import { requireScope, requireSiteRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
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
 */
const app = new Hono<AppEnv>()

const PUBLIC_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'
const MEMBER_CACHE_CONTROL = 'private, no-store'

const listQuery = z.object({
  // Optional, not defaulted: when omitted the site's own `defaultLocale` is used, so an
  // Indonesian-first site serves Indonesian to a caller that names no locale.
  locale: localeCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  sort: z.enum(['publishedAt', 'updatedAt', 'slug']).default('publishedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

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
) {
  const title = typeof data.title === 'string' ? data.title : undefined
  return {
    title:
      entryMeta.metaTitle ??
      applyTitleTemplate(siteMeta.titleTemplate, title) ??
      siteMeta.metaTitle,
    description: entryMeta.description ?? siteMeta.description,
    canonicalUrl: entryMeta.canonicalUrl,
    ogImage: entryMeta.ogImage ?? siteMeta.ogImage,
    keywords: siteMeta.keywords,
    twitterHandle: siteMeta.twitterHandle,
    noIndex: entryMeta.noIndex,
    custom: entryMeta.custom,
    siteCustom: siteMeta.custom,
  }
}

/**
 * Responses differ by member token, so say so — and when one was supplied, keep the answer out
 * of shared caches entirely rather than trusting every hop in front of us to honour `Vary`.
 */
function setCacheHeaders(c: Context<AppEnv>, unlocked: boolean) {
  c.header('vary', MEMBER_TOKEN_HEADER)
  c.header('cache-control', unlocked ? MEMBER_CACHE_CONTROL : PUBLIC_CACHE_CONTROL)
}

/**
 * Drops `data` from anything the caller has not unlocked, so a teaser can still be rendered.
 * Metadata is kept even when locked — a paywalled page still needs its title, description and
 * social tags to be indexed and to render in a link preview.
 */
function toDelivery(row: DeliveryRow, isMember: boolean, siteMeta: SiteMetadata) {
  const locked = row.visibility === 'members' && !isMember
  const entryMeta = entryMetadataSchema.parse(row.metadata ?? {})
  return {
    slug: row.slug,
    locale: row.locale,
    visibility: row.visibility,
    locked,
    ...(locked ? {} : { data: row.data }),
    metadata: resolveDeliveryMetadata(siteMeta, entryMeta, row.data),
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  }
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

  const column = entries[query.sort]
  const filters: SQL[] = [
    eq(entries.collectionId, collection.id),
    eq(entries.status, 'published'),
    eq(entries.locale, query.locale ?? site.defaultLocale),
  ]
  if (query.cursor) {
    filters.push(query.order === 'desc' ? lt(column, query.cursor) : gt(column, query.cursor))
  }

  const rows = await db
    .select(DELIVERY_COLUMNS)
    .from(entries)
    .where(and(...filters))
    .orderBy(query.order === 'desc' ? desc(column) : asc(column))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  const siteMeta = siteMetadataSchema.parse(site.metadata ?? {})

  setCacheHeaders(c, isMember)
  return c.json({
    data: page.map((row) => toDelivery(row, isMember, siteMeta)),
    nextCursor: hasMore ? String(page.at(-1)?.[query.sort] ?? '') : null,
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
  const locale = c.req.query('locale') ?? site.defaultLocale
  const isMember = c.get('member') !== null

  const [row] = await getDb(c.env)
    .select(DELIVERY_COLUMNS)
    .from(entries)
    .innerJoin(collections, eq(collections.id, entries.collectionId))
    .where(
      and(
        eq(collections.siteId, site.id),
        eq(collections.slug, c.req.param('collection')),
        eq(entries.slug, c.req.param('slug')),
        eq(entries.locale, locale),
        eq(entries.status, 'published'),
      ),
    )
    .limit(1)

  if (!row) throw ApiError.notFound('Entry')

  // 403 rather than 404: the entry exists, and the site needs to know to render its paywall.
  if (row.visibility === 'members' && !isMember) {
    throw ApiError.forbidden('This entry is for members only')
  }

  const siteMeta = siteMetadataSchema.parse(site.metadata ?? {})
  setCacheHeaders(c, isMember)
  return c.json({ data: toDelivery(row, isMember, siteMeta) })
})

export default app
