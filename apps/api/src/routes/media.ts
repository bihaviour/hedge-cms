import {
  isAllowedUploadType,
  listMediaQuerySchema,
  MAX_UPLOAD_BYTES,
  updateMediaSchema,
} from '@hedge/core'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { media } from '../db/schema'
import type { AppEnv } from '../env'
import { requireActor, requireScope, requireSiteRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { IMAGE_HEAD_BYTES, readImageSize } from '../lib/image-size'
import { deleteMedia, listMedia, toMedia, updateMedia } from '../lib/media'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'

const app = new Hono<AppEnv>()

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

app.get('/', requireSiteRole('viewer'), requireScope('media:read'), async (c) => {
  const query = validateQuery(c, listMediaQuerySchema)
  return c.json(await listMedia(c.env, requireSite(c).id, query))
})

app.post('/', requireSiteRole('editor'), requireScope('media:write'), async (c) => {
  const site = requireSite(c)
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

  // Dimensions come from the file's head, not the file: `slice` is a view over the blob, so this
  // reads 64 KB whatever the upload weighs, and the body still streams into R2 untouched below.
  const head = new Uint8Array(await file.slice(0, IMAGE_HEAD_BYTES).arrayBuffer())
  const size = readImageSize(head)

  const key = buildKey(site.slug, file.name || 'file')
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
      siteId: site.id,
      key,
      filename: file.name || 'file',
      contentType,
      size: file.size,
      // Null for anything the reader does not recognise, which is what these columns already mean.
      width: size?.width ?? null,
      height: size?.height ?? null,
      alt: (form.get('alt') as string | null) || null,
      uploadedBy: actor.kind === 'user' ? actor.id : null,
    })
    .returning()

  return c.json({ data: toMedia(row!, c.env) }, 201)
})

app.patch('/:id', requireSiteRole('editor'), requireScope('media:write'), async (c) => {
  const input = await validate(c, updateMediaSchema)
  const data = await updateMedia(c.env, requireSite(c).id, c.req.param('id'), input)
  return c.json({ data })
})

app.delete('/:id', requireSiteRole('editor'), requireScope('media:write'), async (c) => {
  await deleteMedia(c.env, requireSite(c).id, c.req.param('id'))
  return c.body(null, 204)
})

export default app
