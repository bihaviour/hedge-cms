import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import type { AppEnv } from './env'
import { resolveActor } from './lib/auth'
import { errorResponse } from './lib/errors'
import { newId } from './lib/id'
import apiKeys from './routes/api-keys'
import auth from './routes/auth'
import collections from './routes/collections'
import content from './routes/content'
import entries from './routes/entries'
import media from './routes/media'
import users from './routes/users'

const app = new Hono<AppEnv>()

app.use('*', async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? newId('req'))
  await next()
})
app.use('*', logger())
app.use('*', secureHeaders())

// The admin SPA is same-origin, so CORS only needs to open up the read-only delivery API.
app.use('/api/v1/content/*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 86400 }))

app.use('/api/*', resolveActor)

app.get('/api/health', (c) =>
  c.json({ status: 'ok', environment: c.env.ENVIRONMENT, version: '0.0.1' }),
)

app.route('/api/v1/auth', auth)
app.route('/api/v1/users', users)
app.route('/api/v1/api-keys', apiKeys)
app.route('/api/v1/collections', collections)
app.route('/api/v1/collections/:collection/entries', entries)
app.route('/api/v1/media', media)
app.route('/api/v1/content', content)

/**
 * Public media passthrough. Objects are written with an immutable cache-control header, so
 * repeat hits are served by Cloudflare's cache without touching R2.
 */
app.get('/media/*', async (c) => {
  const key = decodeURIComponent(c.req.path.slice('/media/'.length))
  if (!key) return c.notFound()

  const object = await c.env.MEDIA.get(key)
  if (!object) return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', object.httpMetadata?.cacheControl ?? 'public, max-age=31536000')

  if (c.req.header('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(object.body, { headers })
})

app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: `No route for ${c.req.path}` } }, 404),
)

app.onError((err, c) => errorResponse(c, err))

export default app
