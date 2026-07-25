import {
  type Collection,
  createCollectionSchema,
  defaultFields,
  fieldsSchema,
  updateCollectionSchema,
} from '@hedge/core'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { type CollectionRow, collections } from '../db/schema'
import type { AppEnv } from '../env'
import { requireScope, requireSiteRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

export function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    fields: fieldsSchema.parse(row.fields),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Collections are namespaced per site, so a lookup is only ever valid within one tenant. */
export async function findCollection(
  env: AppEnv['Bindings'],
  siteId: string,
  slug: string,
): Promise<CollectionRow> {
  const db = getDb(env)
  const [row] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.siteId, siteId), eq(collections.slug, slug)))
    .limit(1)
  if (!row) throw ApiError.notFound('Collection')
  return row
}

app.get('/', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  const site = requireSite(c)
  const rows = await getDb(c.env)
    .select()
    .from(collections)
    .where(eq(collections.siteId, site.id))
    .orderBy(asc(collections.name))
  return c.json({ data: rows.map(toCollection) })
})

app.get('/:slug', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  const row = await findCollection(c.env, requireSite(c).id, c.req.param('slug'))
  return c.json({ data: toCollection(row) })
})

app.post('/', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, createCollectionSchema)
  const db = getDb(c.env)

  const [existing] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.siteId, site.id), eq(collections.slug, input.slug)))
  if (existing) {
    throw ApiError.conflict(`A collection with slug "${input.slug}" already exists on this site`)
  }

  const [row] = await db
    .insert(collections)
    .values({
      id: newId('col'),
      siteId: site.id,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      fields: input.fields ?? defaultFields(),
    })
    .returning()

  return c.json({ data: toCollection(row!) }, 201)
})

app.patch('/:slug', requireSiteRole('admin'), async (c) => {
  const input = await validate(c, updateCollectionSchema)
  const existing = await findCollection(c.env, requireSite(c).id, c.req.param('slug'))
  const db = getDb(c.env)

  const [row] = await db
    .update(collections)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.fields !== undefined ? { fields: input.fields } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(collections.id, existing.id))
    .returning()

  return c.json({ data: toCollection(row!) })
})

app.delete('/:slug', requireSiteRole('admin'), async (c) => {
  const existing = await findCollection(c.env, requireSite(c).id, c.req.param('slug'))
  const db = getDb(c.env)
  // Entries cascade via the foreign key.
  await db.delete(collections).where(eq(collections.id, existing.id))
  return c.body(null, 204)
})

export default app
