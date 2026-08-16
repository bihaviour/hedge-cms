import { listMediaQuerySchema, MAX_UPLOAD_BYTES, updateMediaSchema } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requireActor, requireScope, requireSitePermission } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { deleteMedia, listMedia, storeUpload, updateMedia } from '../lib/media'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'

const app = new Hono<AppEnv>()

app.get('/', requireSitePermission('media:read'), requireScope('media:read'), async (c) => {
  const query = validateQuery(c, listMediaQuerySchema)
  return c.json(await listMedia(c.env, requireSite(c).id, query))
})

app.post('/', requireSitePermission('media:create'), requireScope('media:write'), async (c) => {
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

  // Everything from here — the type check, the R2 write, the dimension read, the row — is shared
  // with `upload_media` on the MCP endpoint. `file.size` is still checked above because a multipart
  // body has a real length to check up front; `storeUpload` counts the stream regardless.
  const data = await storeUpload(c.env, site, {
    body: file.stream(),
    filename: file.name || 'file',
    contentType: file.type || 'application/octet-stream',
    alt: (form.get('alt') as string | null) || null,
    uploadedBy: actor.kind === 'user' ? actor.id : null,
  })

  return c.json({ data }, 201)
})

app.patch('/:id', requireSitePermission('media:update'), requireScope('media:write'), async (c) => {
  const input = await validate(c, updateMediaSchema)
  const data = await updateMedia(c.env, requireSite(c).id, c.req.param('id'), input)
  return c.json({ data })
})

app.delete(
  '/:id',
  requireSitePermission('media:delete'),
  requireScope('media:write'),
  async (c) => {
    await deleteMedia(c.env, requireSite(c).id, c.req.param('id'))
    return c.body(null, 204)
  },
)

export default app
