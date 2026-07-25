import { fieldsSchema } from '@hedge/core'
import { and, asc, desc, eq, gt, lt, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { collections, entries } from '../db/schema'
import type { AppEnv } from '../env'
import { requireScope } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { validateQuery } from '../lib/validate'

/**
 * Read-only delivery API. Only published entries are visible, and responses carry a long
 * `s-maxage` so Cloudflare's cache absorbs the traffic — the origin Worker only runs on miss.
 */
const app = new Hono<AppEnv>()

const CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'

const listQuery = z.object({
  locale: z.string().min(2).max(12).default('en'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  sort: z.enum(['publishedAt', 'updatedAt', 'slug']).default('publishedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

app.use('*', requireScope('content:read'))

app.get('/:collection', async (c) => {
  const query = validateQuery(c, listQuery)
  const db = getDb(c.env)

  const [collection] = await db
    .select()
    .from(collections)
    .where(eq(collections.slug, c.req.param('collection')))
    .limit(1)
  if (!collection) throw ApiError.notFound('Collection')

  const column = entries[query.sort]
  const filters: SQL[] = [
    eq(entries.collectionId, collection.id),
    eq(entries.status, 'published'),
    eq(entries.locale, query.locale),
  ]
  if (query.cursor) {
    filters.push(query.order === 'desc' ? lt(column, query.cursor) : gt(column, query.cursor))
  }

  const rows = await db
    .select({
      slug: entries.slug,
      locale: entries.locale,
      data: entries.data,
      publishedAt: entries.publishedAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(and(...filters))
    .orderBy(query.order === 'desc' ? desc(column) : asc(column))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows

  c.header('cache-control', CACHE_CONTROL)
  return c.json({
    data: page,
    nextCursor: hasMore ? String(page.at(-1)?.[query.sort] ?? '') : null,
  })
})

/** Field definitions for a collection — lets clients generate types or render forms. */
app.get('/:collection/_schema', async (c) => {
  const db = getDb(c.env)
  const [collection] = await db
    .select()
    .from(collections)
    .where(eq(collections.slug, c.req.param('collection')))
    .limit(1)
  if (!collection) throw ApiError.notFound('Collection')

  c.header('cache-control', CACHE_CONTROL)
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
  const locale = c.req.query('locale') ?? 'en'
  const db = getDb(c.env)

  const [row] = await db
    .select({
      slug: entries.slug,
      locale: entries.locale,
      data: entries.data,
      publishedAt: entries.publishedAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .innerJoin(collections, eq(collections.id, entries.collectionId))
    .where(
      and(
        eq(collections.slug, c.req.param('collection')),
        eq(entries.slug, c.req.param('slug')),
        eq(entries.locale, locale),
        eq(entries.status, 'published'),
      ),
    )
    .limit(1)

  if (!row) throw ApiError.notFound('Entry')

  c.header('cache-control', CACHE_CONTROL)
  return c.json({ data: row })
})

export default app
