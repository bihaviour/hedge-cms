import {
  isAllowedUploadType,
  type ListMediaQuery,
  MAX_UPLOAD_BYTES,
  type Media,
  type MediaTypeFilter,
  type Paginated,
  type UpdateMediaInput,
} from '@hedge/core'
import { and, count, desc, eq, like, lt, not, or, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type MediaRow, media } from '../db/schema'
import type { Bindings } from '../env'
import { ApiError } from './errors'
import { newId } from './id'
import { IMAGE_HEAD_BYTES, readImageSize } from './image-size'

/**
 * Media operations shared by the REST route and the MCP endpoint — including the upload itself.
 *
 * `storeUpload` lives here rather than in `routes/media.ts` because there are now two ways a file
 * arrives (a multipart body, and a URL the Worker fetches for `upload_media`) and exactly one of
 * them may own the R2 write, the key layout, the dimension read and the row. Two copies of that is
 * how the two paths drift into storing different things for the same file.
 */

/** `blog/2026/07/k1a2b3-photo.jpg` — site- and date-prefixed so the bucket stays browsable. */
function buildKey(siteSlug: string, filename: string): string {
  const now = new Date()
  const safe = filename
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-80)
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${siteSlug}/${now.getUTCFullYear()}/${month}/${newId()}-${safe || 'file'}`
}

export interface StoreUploadInput {
  body: ReadableStream<Uint8Array>
  filename: string
  contentType: string
  alt?: string | null
  /** The user this is attributed to, or null for a machine actor — matching the column. */
  uploadedBy?: string | null
}

/**
 * What a metered upload learned on its way past: the head, for dimensions, and the true length.
 *
 * Both come out of the *stream*, not out of a header or a `File.size`, and that is the difference
 * that matters for a fetched URL: `content-length` is a claim by somebody else's server, and a
 * chunked response makes no claim at all.
 */
interface Metered {
  head: Uint8Array
  bytes: number
}

/**
 * Wraps a body so it can be measured while it streams, without ever holding the whole of it.
 *
 * Two jobs in one pass. It keeps the first `IMAGE_HEAD_BYTES` — which is all `readImageSize` reads,
 * whatever the file weighs — and it counts every byte, erroring the stream the moment the count
 * passes `MAX_UPLOAD_BYTES`. Erroring mid-stream is what makes the cap real rather than advisory:
 * the R2 write fails with it, so an oversized file cannot land and then be rejected afterwards.
 */
function meter(body: ReadableStream<Uint8Array>, into: Metered): ReadableStream<Uint8Array> {
  const head: Uint8Array[] = []
  let headBytes = 0

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        into.bytes += chunk.byteLength
        if (into.bytes > MAX_UPLOAD_BYTES) {
          controller.error(
            new ApiError('payload_too_large', `Files must be under ${MAX_UPLOAD_BYTES} bytes`),
          )
          return
        }
        if (headBytes < IMAGE_HEAD_BYTES) {
          const take = chunk.subarray(0, IMAGE_HEAD_BYTES - headBytes)
          head.push(take)
          headBytes += take.byteLength
        }
        controller.enqueue(chunk)
      },
      flush() {
        const joined = new Uint8Array(headBytes)
        let offset = 0
        for (const part of head) {
          joined.set(part, offset)
          offset += part.byteLength
        }
        into.head = joined
      },
    }),
  )
}

/**
 * Streams a file into R2 and records it. The one place either upload path writes an object.
 *
 * The content type is checked here rather than by each caller, so a source added later cannot skip
 * it — `upload_media` fetching an arbitrary URL is exactly the caller that would.
 */
export async function storeUpload(
  env: Bindings,
  site: { id: string; slug: string },
  input: StoreUploadInput,
): Promise<Media> {
  const contentType = input.contentType.split(';')[0]!.trim() || 'application/octet-stream'
  if (!isAllowedUploadType(contentType)) {
    void input.body.cancel()
    throw new ApiError('unsupported_media_type', `Files of type "${contentType}" are not allowed`)
  }

  const key = buildKey(site.slug, input.filename)
  const metered: Metered = { head: new Uint8Array(), bytes: 0 }

  try {
    await env.MEDIA.put(key, meter(input.body, metered), {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    })
  } catch (error) {
    // A body that tripped the cap failed *during* the write, so the object may be partly there.
    // Nothing references it — no row was written — so it would sit in the bucket unreachable.
    await env.MEDIA.delete(key).catch(() => {})
    throw error instanceof ApiError
      ? error
      : new ApiError('internal_error', 'The upload could not be stored')
  }

  const size = readImageSize(metered.head)

  const [row] = await getDb(env)
    .insert(media)
    .values({
      id: newId('med'),
      siteId: site.id,
      key,
      filename: input.filename || 'file',
      contentType,
      size: metered.bytes,
      // Null for anything the reader does not recognise, which is what these columns already mean.
      width: size?.width ?? null,
      height: size?.height ?? null,
      alt: input.alt || null,
      uploadedBy: input.uploadedBy ?? null,
    })
    .returning()

  return toMedia(row!, env)
}

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

/**
 * `document` is everything that is not a picture or a video, expressed as a negation so a newly
 * allowed upload type belongs to it without anyone remembering to widen a list.
 */
function contentTypeFilter(type: MediaTypeFilter): SQL {
  if (type === 'document') {
    return and(
      not(like(media.contentType, 'image/%')),
      not(like(media.contentType, 'video/%')),
    ) as SQL
  }
  return like(media.contentType, `${type}/%`)
}

export async function listMedia(
  env: Bindings,
  siteId: string,
  options: ListMediaQuery,
): Promise<Paginated<Media>> {
  const filters: SQL[] = [eq(media.siteId, siteId)]
  if (options.type) filters.push(contentTypeFilter(options.type))
  if (options.q) {
    // Alt text is searched alongside the filename because a filename is `IMG_4821.jpg` more
    // often than not, and alt is the only description a person ever wrote for the file.
    const pattern = `%${options.q}%`
    filters.push(or(like(media.filename, pattern), like(media.alt, pattern)) as SQL)
  }

  // The cursor narrows the page, not the count — see `listEntries` for why they are kept apart.
  const pageFilters = options.cursor ? [...filters, lt(media.id, options.cursor)] : filters

  const db = getDb(env)
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(media)
      .where(and(...pageFilters))
      .orderBy(desc(media.id))
      .limit(options.limit + 1),
    db
      .select({ value: count() })
      .from(media)
      .where(and(...filters)),
  ])

  const hasMore = rows.length > options.limit
  const page = hasMore ? rows.slice(0, options.limit) : rows

  return {
    data: page.map((row) => toMedia(row, env)),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    total: counted?.value ?? 0,
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
