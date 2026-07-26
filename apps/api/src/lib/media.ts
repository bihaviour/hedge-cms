import type { Media, UpdateMediaInput } from '@hedge/core'
import { and, desc, eq, lt, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type MediaRow, media } from '../db/schema'
import type { Bindings } from '../env'
import { ApiError } from './errors'

/**
 * Media metadata operations shared by the REST route and the MCP endpoint.
 *
 * Uploading is deliberately not here: it takes a multipart body and a stream into R2, neither of
 * which survives a JSON-RPC round trip. The route keeps that one to itself.
 */

export function toMedia(row: MediaRow, env: Bindings): Media {
  return {
    id: row.id,
    key: row.key,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    width: row.width,
    height: row.height,
    alt: row.alt,
    url: `${env.PUBLIC_URL}/media/${row.key}`,
    createdAt: row.createdAt,
  }
}

export async function listMedia(
  env: Bindings,
  siteId: string,
  options: { limit: number; cursor?: string },
): Promise<{ data: Media[]; nextCursor: string | null }> {
  const filters: SQL[] = [eq(media.siteId, siteId)]
  if (options.cursor) filters.push(lt(media.id, options.cursor))

  const rows = await getDb(env)
    .select()
    .from(media)
    .where(and(...filters))
    .orderBy(desc(media.id))
    .limit(options.limit + 1)

  const hasMore = rows.length > options.limit
  const page = hasMore ? rows.slice(0, options.limit) : rows

  return {
    data: page.map((row) => toMedia(row, env)),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  }
}

export async function getMedia(env: Bindings, siteId: string, id: string): Promise<Media> {
  const [row] = await getDb(env)
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.siteId, siteId)))
    .limit(1)

  if (!row) throw ApiError.notFound('Media')
  return toMedia(row, env)
}

export async function updateMedia(
  env: Bindings,
  siteId: string,
  id: string,
  input: UpdateMediaInput,
): Promise<Media> {
  const [row] = await getDb(env)
    .update(media)
    .set({
      ...(input.alt !== undefined ? { alt: input.alt } : {}),
      ...(input.filename !== undefined ? { filename: input.filename } : {}),
    })
    .where(and(eq(media.id, id), eq(media.siteId, siteId)))
    .returning()

  if (!row) throw ApiError.notFound('Media')
  return toMedia(row, env)
}

/** Removes the row and the object behind it — the bucket would otherwise keep paying for it. */
export async function deleteMedia(env: Bindings, siteId: string, id: string): Promise<void> {
  const [row] = await getDb(env)
    .delete(media)
    .where(and(eq(media.id, id), eq(media.siteId, siteId)))
    .returning()

  if (!row) throw ApiError.notFound('Media')
  await env.MEDIA.delete(row.key)
}
