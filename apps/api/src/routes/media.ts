import { isAllowedUploadType, MAX_UPLOAD_BYTES, type Media, updateMediaSchema } from '@hedge/core'
import { desc, eq, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { type MediaRow, media } from '../db/schema'
import type { AppEnv, Bindings } from '../env'
import { requireActor, requireRole, requireScope } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { validate, validateQuery } from '../lib/validate'

const app = new Hono<AppEnv>()

function toMedia(row: MediaRow, env: Bindings): Media {
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

/** `2026/07/k1a2b3-photo.jpg` — date-prefixed so the bucket stays browsable. */
function buildKey(filename: string): string {
  const now = new Date()
  const safe = filename
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-80)
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${now.getUTCFullYear()}/${month}/${newId()}-${safe || 'file'}`
}

app.get('/', requireScope('media:read'), async (c) => {
  const query = validateQuery(
    c,
    z.object({
      limit: z.coerce.number().int().min(1).max(100).default(24),
      cursor: z.string().optional(),
    }),
  )
  const db = getDb(c.env)

  const rows = await db
    .select()
    .from(media)
    .where(query.cursor ? lt(media.id, query.cursor) : undefined)
    .orderBy(desc(media.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows

  return c.json({
    data: page.map((row) => toMedia(row, c.env)),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  })
})

app.post('/', requireRole('editor'), requireScope('media:write'), async (c) => {
  const actor = requireActor(c)
  const contentLength = Number(c.req.header('content-length') ?? 0)
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw new ApiError('payload_too_large', `Files must be under ${MAX_UPLOAD_BYTES} bytes`)
  }

  const form = await c.req.formData().catch(() => {
    throw ApiError.badRequest('Expected a multipart/form-data body with a "file" field')
  })
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing "file" field')

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError('payload_too_large', `Files must be under ${MAX_UPLOAD_BYTES} bytes`)
  }
  const contentType = file.type || 'application/octet-stream'
  if (!isAllowedUploadType(contentType)) {
    throw new ApiError('unsupported_media_type', `Files of type "${contentType}" are not allowed`)
  }

  const key = buildKey(file.name || 'file')
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  const db = getDb(c.env)
  const [row] = await db
    .insert(media)
    .values({
      id: newId('med'),
      key,
      filename: file.name || 'file',
      contentType,
      size: file.size,
      alt: (form.get('alt') as string | null) || null,
      uploadedBy: actor.kind === 'user' ? actor.id : null,
    })
    .returning()

  return c.json({ data: toMedia(row!, c.env) }, 201)
})

app.patch('/:id', requireRole('editor'), requireScope('media:write'), async (c) => {
  const input = await validate(c, updateMediaSchema)
  const db = getDb(c.env)

  const [row] = await db
    .update(media)
    .set({
      ...(input.alt !== undefined ? { alt: input.alt } : {}),
      ...(input.filename !== undefined ? { filename: input.filename } : {}),
    })
    .where(eq(media.id, c.req.param('id')))
    .returning()

  if (!row) throw ApiError.notFound('Media')
  return c.json({ data: toMedia(row, c.env) })
})

app.delete('/:id', requireRole('editor'), requireScope('media:write'), async (c) => {
  const db = getDb(c.env)
  const [row] = await db
    .delete(media)
    .where(eq(media.id, c.req.param('id')))
    .returning()
  if (!row) throw ApiError.notFound('Media')

  await c.env.MEDIA.delete(row.key)
  return c.body(null, 204)
})

export default app
