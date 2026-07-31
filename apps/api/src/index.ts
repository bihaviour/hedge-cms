import { HEDGE_VERSION, MEMBER_TOKEN_HEADER, PREVIEW_TOKEN_HEADER, SITE_HEADER } from '@hedge/core'
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { CMS_AUTH_BASE_PATH, getCmsAuth } from './auth/cms'
import { getMemberAuth, MEMBER_AUTH_BASE_PATH } from './auth/member'
import type { AppEnv } from './env'
import { resolveSessionActor } from './lib/auth'
import { resolveDeliveryActor, resolveSessionOrKeyActor } from './lib/delivery-auth'
import { errorResponse } from './lib/errors'
import { newId } from './lib/id'
import { resolveMember } from './lib/member-auth'
import { resolvePreview } from './lib/preview'
import { resolveSite } from './lib/site'
import apiKeys from './routes/api-keys'
import auth from './routes/auth'
import collections from './routes/collections'
import content from './routes/content'
import email from './routes/email'
import entries from './routes/entries'
import mcp from './routes/mcp'
import media from './routes/media'
import members, { memberAuth } from './routes/members'
import newsletterPublic from './routes/newsletter-public'
import newsletterTemplates from './routes/newsletter-templates'
import newsletters, { subscribers } from './routes/newsletters'
import review from './routes/review'
import roles from './routes/roles'
import sites from './routes/sites'
import system from './routes/system'
import users from './routes/users'

const app = new Hono<AppEnv>()

/**
 * Management routes reachable **only** with an admin session. Identity, tenancy, delivery keys
 * themselves, and everything that sends mail — none of it is a machine's business, so no API key is
 * ever resolved here.
 */
const ADMIN_PREFIXES = [
  '/api/v1/auth',
  '/api/v1/users',
  '/api/v1/roles',
  '/api/v1/sites',
  '/api/v1/api-keys',
  '/api/v1/members',
  '/api/v1/email',
  '/api/v1/newsletters',
  '/api/v1/newsletter-templates',
  '/api/v1/subscribers',
  '/api/v1/system',
  // The review inbox — one person's queue of decisions. A machine never makes one, so no key is
  // resolved here even though the versions it lists are authored on the key-managed routes below.
  '/api/v1/review',
]

/**
 * Management routes an admin session **or a write-scoped API key** may reach — the authoring
 * surface, so an import script or another service can create content without a person's password.
 *
 * Only content and media, deliberately: a key that can write entries still cannot invite a user,
 * create a site, read a member's email or mint another key. A key with no write scope is not
 * resolved here at all, so the credential a public website holds stays confined to the delivery
 * API and its published-only view. See `resolveSessionOrKeyActor`.
 */
const KEY_MANAGED_PREFIXES = ['/api/v1/collections', '/api/v1/media']

const DELIVERY_PREFIX = '/api/v1/content'
const MEMBER_PREFIX = '/api/v1/member/'

const startsWithPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`)

/**
 * A deployment does not always know its own URL: a one-click deploy lands on a generated
 * workers.dev subdomain, and locally the port is whatever `wrangler dev` picked. Where `PUBLIC_URL`
 * is unset, the origin of the request being answered is the truthful value, so it is filled in
 * before anything reads it — auth base URLs, invite and reset links, media URLs and the OAuth
 * resource identifier all come from it. Setting the var, as a deployment with a custom domain
 * should, always wins.
 *
 * This runs first, and mutates `env` rather than passing an origin around, because the two Better
 * Auth instances are built once per isolate from `env` and never see a request.
 *
 * Deriving a base URL from the request is host header injection anywhere the Host is attacker
 * controlled — a poisoned reset link is the classic result. It is not here: Cloudflare routes to a
 * Worker *by hostname*, so the only origins that reach this code are ones the deployment itself
 * answers on. The residual case is a deployment reachable at two of its own hostnames — a custom
 * domain plus the workers.dev one — where a reset requested through the second emails a link on it.
 * The token is still redeemed here and leaks nowhere, but that is the case `PUBLIC_URL` is for.
 */
app.use('*', async (c, next) => {
  if (!c.env.PUBLIC_URL) c.env.PUBLIC_URL = new URL(c.req.url).origin
  await next()
})

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
    allowHeaders: [
      'authorization',
      'content-type',
      SITE_HEADER,
      MEMBER_TOKEN_HEADER,
      PREVIEW_TOKEN_HEADER,
    ],
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
// A website's signup form posts here from its own origin, and unsubscribe links open here directly.
app.use(
  '/api/v1/newsletter/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type', SITE_HEADER],
    maxAge: 86400,
  }),
)
// An MCP client may run in a browser, and has to be able to read the challenge that tells it
// where to authenticate. Bearer tokens are sent explicitly, so a wildcard origin grants nothing.
app.use(
  '/api/v1/mcp',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', SITE_HEADER],
    exposeHeaders: ['WWW-Authenticate'],
    maxAge: 86400,
  }),
)
app.use(
  `${CMS_AUTH_BASE_PATH}/mcp/token`,
  cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }),
)
app.use(
  `${CMS_AUTH_BASE_PATH}/mcp/register`,
  cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }),
)

/**
 * Which credential a route accepts is decided here, once, by where the route lives — rather than
 * by each handler remembering to check. Three tiers, narrowing as the authority grows:
 *
 * - the delivery API takes any API key, and serves published content only
 * - the authoring routes take a session or a *write-scoped* key
 * - everything else management takes a session and nothing else
 *
 * So the key sitting in a public website's environment cannot reach a management route even if that
 * route's own authorisation is wrong, and the key an import script holds still cannot touch users,
 * sites or members. MCP resolves its own OAuth token, and member tokens never produce an actor.
 */
app.use('/api/*', async (c, next) => {
  const path = c.req.path

  if (startsWithPrefix(path, DELIVERY_PREFIX)) return resolveDeliveryActor(c, next)
  if (KEY_MANAGED_PREFIXES.some((prefix) => startsWithPrefix(path, prefix))) {
    return resolveSessionOrKeyActor(c, next)
  }
  if (ADMIN_PREFIXES.some((prefix) => startsWithPrefix(path, prefix))) {
    return resolveSessionActor(c, next)
  }

  c.set('actor', null)
  await next()
})

// The site is resolved after the actor, because an API key is bound to the site it was issued for.
app.use('/api/*', resolveSite)

app.use('/api/*', async (c, next) => {
  const path = c.req.path
  if (startsWithPrefix(path, DELIVERY_PREFIX) || path.startsWith(MEMBER_PREFIX)) {
    return resolveMember(c, next)
  }

  c.set('member', null)
  await next()
})

/**
 * Preview tokens resolve on the delivery API and nowhere else — the same separation-by-prefix that
 * keeps a delivery key out of the management API, applied to the credential that unlocks drafts.
 * It runs after `resolveSite` so the token's own site can be checked against the resolved tenant.
 */
app.use('/api/*', async (c, next) => {
  if (startsWithPrefix(c.req.path, DELIVERY_PREFIX)) return resolvePreview(c, next)

  c.set('preview', null)
  await next()
})

app.get('/api/health', (c) =>
  c.json({ status: 'ok', environment: c.env.ENVIRONMENT, version: HEDGE_VERSION }),
)

/* ------------------------------------------------------------------ *
 * OAuth 2.1 discovery.
 *
 * Mounted at the root because that is where a client looks: given nothing but the MCP endpoint's
 * URL, it fetches the protected-resource document, learns which authorization server to talk to,
 * registers itself there and sends the operator through a browser sign-in.
 * ------------------------------------------------------------------ */

app.get('/.well-known/oauth-authorization-server', (c) =>
  oAuthDiscoveryMetadata(getCmsAuth(c.env))(c.req.raw),
)
app.on(
  'GET',
  [
    '/.well-known/oauth-protected-resource',
    // RFC 9728's path-suffixed form, for clients that derive it from the resource URL.
    '/.well-known/oauth-protected-resource/api/v1/mcp',
  ],
  (c) => oAuthProtectedResourceMetadata(getCmsAuth(c.env))(c.req.raw),
)

/**
 * Better Auth only shows the consent screen when the client asks for it with `prompt=consent`, and
 * a client is under no obligation to ask. Left alone, any registered client could be handed a token
 * for a signed-in operator without them ever seeing what it was for — so the prompt is not the
 * client's to decide.
 */
app.get(`${CMS_AUTH_BASE_PATH}/mcp/authorize`, (c) => {
  const url = new URL(c.req.url)
  const prompt = url.searchParams.get('prompt')

  if (prompt?.split(/\s+/).includes('consent')) return getCmsAuth(c.env).handler(c.req.raw)

  url.searchParams.set('prompt', prompt ? `${prompt} consent` : 'consent')
  return getCmsAuth(c.env).handler(new Request(url, c.req.raw))
})

/* ------------------------------------------------------------------ *
 * Routes. The hedge facades are registered before Better Auth's own handlers, so a path they both
 * define — `/api/v1/auth/reset-password`, say — is answered by ours, in our error format.
 * ------------------------------------------------------------------ */

app.route('/api/v1/auth', auth)
app.all(`${CMS_AUTH_BASE_PATH}/*`, (c) => getCmsAuth(c.env).handler(c.req.raw))

app.route('/api/v1/users', users)
app.route('/api/v1/roles', roles)
app.route('/api/v1/sites', sites)
app.route('/api/v1/api-keys', apiKeys)
app.route('/api/v1/collections', collections)
app.route('/api/v1/collections/:collection/entries', entries)
app.route('/api/v1/media', media)
// Entry versions waiting on the signed-in person, for the active site.
app.route('/api/v1/review', review)
app.route('/api/v1/email', email)
app.route('/api/v1/newsletters', newsletters)
app.route('/api/v1/newsletter-templates', newsletterTemplates)
app.route('/api/v1/subscribers', subscribers)
// Deployment-level version and update awareness — admin-only, like everything under /system.
app.route('/api/v1/system', system)
// Public newsletter signup and unsubscribe — resolves no actor, like the member auth facade.
app.route('/api/v1/newsletter', newsletterPublic)
app.route('/api/v1/content', content)
// Model Context Protocol endpoint — collection management for MCP clients (Streamable HTTP).
app.route('/api/v1/mcp', mcp)
// Website visitors sign in here; `/members` below is admin-side management of the same people.
app.route('/api/v1/member', memberAuth)
app.all(`${MEMBER_AUTH_BASE_PATH}/*`, (c) => getMemberAuth(c.env).handler(c.req.raw))
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
