import {
  type Collection,
  type CreateCollectionInput,
  defaultFields,
  fieldsSchema,
  type UpdateCollectionInput,
} from '@hedge/core'
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type CollectionRow, collections } from '../db/schema'
import type { Bindings } from '../env'
import { ApiError } from './errors'
import { newId } from './id'

/**
 * Collection CRUD, factored out of the HTTP route so the REST API and the MCP endpoint drive
 * exactly the same logic — same validation, same conflict and not-found behaviour.
 */

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
  env: Bindings,
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

export async function listCollections(env: Bindings, siteId: string): Promise<Collection[]> {
  const rows = await getDb(env)
    .select()
    .from(collections)
    .where(eq(collections.siteId, siteId))
    .orderBy(asc(collections.name))
  return rows.map(toCollection)
}

export async function getCollection(
  env: Bindings,
  siteId: string,
  slug: string,
): Promise<Collection> {
  return toCollection(await findCollection(env, siteId, slug))
}

export async function createCollection(
  env: Bindings,
  siteId: string,
  input: CreateCollectionInput,
): Promise<Collection> {
  const db = getDb(env)

  const [existing] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.siteId, siteId), eq(collections.slug, input.slug)))
  if (existing) {
    throw ApiError.conflict(`A collection with slug "${input.slug}" already exists on this site`)
  }

  const [row] = await db
    .insert(collections)
    .values({
      id: newId('col'),
      siteId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      fields: input.fields ?? defaultFields(),
    })
    .returning()

  return toCollection(row!)
}

export async function updateCollection(
  env: Bindings,
  siteId: string,
  slug: string,
  input: UpdateCollectionInput,
): Promise<Collection> {
  const existing = await findCollection(env, siteId, slug)
  const [row] = await getDb(env)
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

  return toCollection(row!)
}

export async function deleteCollection(env: Bindings, siteId: string, slug: string): Promise<void> {
  const existing = await findCollection(env, siteId, slug)
  // Entries cascade via the foreign key.
  await getDb(env).delete(collections).where(eq(collections.id, existing.id))
}
