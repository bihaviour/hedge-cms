import {
  type Collection,
  createCollectionSchema,
  defaultFields,
  fieldsSchema,
  updateCollectionSchema,
} from '@hedge/core'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { type CollectionRow, collections } from '../db/schema'
import type { AppEnv } from '../env'
import { requireRole, requireScope } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
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

export async function findCollection(
  env: AppEnv['Bindings'],
  slug: string,
): Promise<CollectionRow> {
  const db = getDb(env)
  const [row] = await db.select().from(collections).where(eq(collections.slug, slug)).limit(1)
  if (!row) throw ApiError.notFound('Collection')
  return row
}

app.get('/', requireScope('content:read'), async (c) => {
  const db = getDb(c.env)
  const rows = await db.select().from(collections).orderBy(asc(collections.name))
  return c.json({ data: rows.map(toCollection) })
})

app.get('/:slug', requireScope('content:read'), async (c) => {
  const row = await findCollection(c.env, c.req.param('slug'))
  return c.json({ data: toCollection(row) })
})

app.post('/', requireRole('admin'), async (c) => {
  const input = await validate(c, createCollectionSchema)
  const db = getDb(c.env)

  const [existing] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.slug, input.slug))
  if (existing) throw ApiError.conflict(`A collection with slug "${input.slug}" already exists`)

  const [row] = await db
    .insert(collections)
    .values({
      id: newId('col'),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      fields: input.fields ?? defaultFields(),
    })
    .returning()

  return c.json({ data: toCollection(row!) }, 201)
})

app.patch('/:slug', requireRole('admin'), async (c) => {
  const input = await validate(c, updateCollectionSchema)
  const existing = await findCollection(c.env, c.req.param('slug'))
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

app.delete('/:slug', requireRole('admin'), async (c) => {
  const existing = await findCollection(c.env, c.req.param('slug'))
  const db = getDb(c.env)
  // Entries cascade via the foreign key.
  await db.delete(collections).where(eq(collections.id, existing.id))
  return c.body(null, 204)
})

export default app
