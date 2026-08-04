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
  websiteOrigin,
} from '@hedge/core'
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
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
  onePerTranslationGroup,
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
  translationGroupId: entries.translationGroupId,
  visibility: entries.visibility,
  data: entries.data,
  metadata: entries.metadata,
  publishedAt: entries.publishedAt,
  updatedAt: entries.updatedAt,
}

interface DeliveryRow {
  slug: string
  locale: string
  translationGroupId: string
  visibility: EntryVisibility
  data: Record<string, unknown>
  metadata: Record<string, unknown> | null
  publishedAt: string | null
  updatedAt: string
}

/** One published language of a post: what a website needs to emit `hreflang` alternates. */
interface Alternate {
  locale: string
  slug: string
}

/**
 * The published languages of a set of posts, keyed by group — one query per batch, not per row.
 *
 * Deliberately not `loadTranslations` from `lib/entries.ts`, which is the management one and
 * includes drafts. A draft translation's slug is unpublished content: emitting it in `alternates`
 * would hand every reader the URL of a page nobody has approved.
 */
async function loadAlternates(
  env: Bindings,
  groupIds: string[],
): Promise<Map<string, Alternate[]>> {
  const byGroup = new Map<string, Alternate[]>()
  const unique = [...new Set(groupIds)]
  if (unique.length === 0) return byGroup

  const db = getDb(env)
  for (let i = 0; i < unique.length; i += KEY_BATCH) {
    const rows = await db
      .select({
        groupId: entries.translationGroupId,
        locale: entries.locale,
        slug: entries.slug,
      })
      .from(entries)
      .where(
        and(
          inArray(entries.translationGroupId, unique.slice(i, i + KEY_BATCH)),
          eq(entries.status, 'published'),
        ),
      )
    for (const row of rows) {
      const list = byGroup.get(row.groupId) ?? []
      list.push({ locale: row.locale, slug: row.slug })
      byGroup.set(row.groupId, list)
    }
  }

  return byGroup
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
  /** The locale the caller asked for, when it differs from the one that could be served. */
  requestedLocale?: string,
  alternates?: Alternate[],
) {
  const locked = row.visibility === 'members' && !isMember
  const entryMeta = entryMetadataSchema.parse(row.metadata ?? {})
  return {
    slug: row.slug,
    // Always the locale of the content in this payload, never the one that was asked for. A caller
    // that renders `lang="..."` from it must be telling the truth about what the text is.
    locale: row.locale,
    /**
     * This post has no variant in the requested language, so another one was served rather than the
     * post being hidden. Present on every entry so a caller can act on it — render a "not available
     * in your language" note, or skip the row — without diffing locales itself.
     */
    localeFallback: requestedLocale !== undefined && requestedLocale !== row.locale,
    /** Every published language of this post, for `hreflang`. Slugs differ per locale. */
    ...(alternates ? { alternates } : {}),
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

  const requestedLocale = query.locale ?? site.defaultLocale
  const filters: SQL[] = [
    eq(entries.collectionId, collection.id),
    eq(entries.status, 'published'),
    // One row per post rather than one per translation, and the row is the best language available:
    // the one asked for, else the site's default, else whatever the post does have. An index in
    // Indonesian therefore lists every published post — the translated ones in Indonesian and the
    // rest in the site's own language — instead of showing only the fraction already translated.
    // Each item says which language it actually is, and `localeFallback` says whether that was the
    // one asked for, so a caller that would rather show nothing can still tell.
    onePerTranslationGroup(requestedLocale, site.defaultLocale, { publishedOnly: true }),
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
    websiteOrigin(site),
  )
  const alternates = await loadAlternates(
    c.env,
    page.map((row) => row.translationGroupId),
  )

  setCacheHeaders(c, isMember)
  return c.json({
    data: page.map((row, index) =>
      toDelivery(
        row,
        isMember,
        siteMeta,
        c.env.PUBLIC_URL,
        websiteOrigin(site),
        resolved?.[index],
        requestedLocale,
        alternates.get(row.translationGroupId) ?? [],
      ),
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
  const askedFor = c.req.query('locale')
  const isMember = c.get('member') !== null
  const db = getDb(c.env)

  // Only a token minted for *this* collection, slug and locale counts. Anything else — including a
  // valid token for the entry next door — leaves the published-only view exactly as it was. A
  // preview names one exact variant and is deliberately left out of the fallback below: the point
  // of previewing is to see the draft you are holding, and quietly serving its published sibling
  // instead would be the one answer that cannot be right.
  const previewLocale = askedFor ?? site.defaultLocale
  const preview = previewFor(c, collectionSlug, slug, previewLocale)

  // Which post this slug names, in whichever language the slug happens to be written. Not filtered
  // by locale: `halo-dunia` and `hello-world` are two languages of one post now, and either address
  // has to resolve to it.
  const addressed = await db
    // The collection's fields come along for the ride: resolving media needs to know which of
    // this entry's values are keys, and the join is already here.
    .select({ ...DELIVERY_COLUMNS, status: entries.status, fields: collections.fields })
    .from(entries)
    .innerJoin(collections, eq(collections.id, entries.collectionId))
    .where(
      and(
        eq(collections.siteId, site.id),
        eq(collections.slug, collectionSlug),
        eq(entries.slug, slug),
      ),
    )

  const anchor = addressed[0]
  if (!anchor) throw ApiError.notFound('Entry')

  let row: (typeof addressed)[number] | undefined
  let requestedLocale: string
  let alternates: Alternate[] = []

  if (preview) {
    // Exactly the row the token names, published or not.
    row = addressed.find((candidate) => candidate.locale === previewLocale)
    requestedLocale = previewLocale
  } else {
    // Every language of this post, oldest variant first, scoped to the collection so a group can
    // never be read across one.
    const variants = await db
      .select({ ...DELIVERY_COLUMNS, status: entries.status, fields: collections.fields })
      .from(entries)
      .innerJoin(collections, eq(collections.id, entries.collectionId))
      .where(
        and(
          eq(collections.siteId, site.id),
          eq(collections.slug, collectionSlug),
          eq(entries.translationGroupId, anchor.translationGroupId),
        ),
      )
      .orderBy(asc(entries.id))

    const published = variants.filter((candidate) => candidate.status === 'published')
    alternates = published.map((candidate) => ({ locale: candidate.locale, slug: candidate.slug }))

    // A slug that belongs to exactly one language *is* a request for that language — asking for
    // `/halo-dunia` with no `?locale=` means the Indonesian one, not the site default that happens
    // to share the URL shape. A slug several languages share (every post authored before slugs
    // could differ) is ambiguous, so it defers to the site default, exactly as it used to.
    requestedLocale = askedFor ?? (addressed.length === 1 ? anchor.locale : site.defaultLocale)

    row =
      published.find((candidate) => candidate.locale === requestedLocale) ??
      published.find((candidate) => candidate.locale === site.defaultLocale) ??
      published[0]
  }

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
    websiteOrigin(site),
  )

  setCacheHeaders(c, unlocked)
  return c.json({
    data: toDelivery(
      row,
      unlocked,
      siteMeta,
      c.env.PUBLIC_URL,
      websiteOrigin(site),
      resolved?.[0],
      requestedLocale,
      alternates,
    ),
  })
})

export default app
