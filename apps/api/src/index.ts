import { MEMBER_TOKEN_HEADER, SITE_HEADER } from '@hedge/core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import type { AppEnv } from './env'
import { resolveActor } from './lib/auth'
import { errorResponse } from './lib/errors'
import { newId } from './lib/id'
import { resolveMember } from './lib/member-auth'
import { resolveSite } from './lib/site'
import apiKeys from './routes/api-keys'
import auth from './routes/auth'
import collections from './routes/collections'
import content from './routes/content'
import entries from './routes/entries'
import media from './routes/media'
import members, { memberAuth } from './routes/members'
import sites from './routes/sites'
import users from './routes/users'

const app = new Hono<AppEnv>()

app.use('*', async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? newId('req'))
  await next()
})
app.use('*', logger())
app.use('*', secureHeaders())

// The admin SPA is same-origin, so CORS only needs to open up what a website calls: the
// read-only delivery API and member sign-in. Both are token-authenticated rather than
// cookie-authenticated, so `origin: '*'` carries no ambient credentials.
app.use(
  '/api/v1/content/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', SITE_HEADER, MEMBER_TOKEN_HEADER],
    maxAge: 86400,
  }),
)
app.use(
  '/api/v1/member/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type', SITE_HEADER, MEMBER_TOKEN_HEADER],
    maxAge: 86400,
  }),
)

// Order matters: the site is resolved from the actor's API key, and a member token is only
// honoured for the site it was issued on.
app.use('/api/*', resolveActor)
app.use('/api/*', resolveSite)
app.use('/api/*', resolveMember)

app.get('/api/health', (c) =>
  c.json({ status: 'ok', environment: c.env.ENVIRONMENT, version: '0.0.1' }),
)

app.route('/api/v1/auth', auth)
app.route('/api/v1/users', users)
app.route('/api/v1/sites', sites)
app.route('/api/v1/api-keys', apiKeys)
app.route('/api/v1/collections', collections)
app.route('/api/v1/collections/:collection/entries', entries)
app.route('/api/v1/media', media)
app.route('/api/v1/content', content)
// Website visitors sign in here; `/members` below is admin-side management of the same people.
app.route('/api/v1/member', memberAuth)
app.route('/api/v1/members', members)

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
