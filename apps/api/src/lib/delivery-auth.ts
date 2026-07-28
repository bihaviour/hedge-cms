import type { Role } from '@hedge/core'
import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getDb } from '../db/client'
import { apiKeys } from '../db/schema'
import type { Actor, AppEnv } from '../env'
import { API_KEY_PREFIX, resolveSessionActor } from './auth'
import { hmac } from './crypto'

/**
 * The site role a key acts with, derived from what it was issued to do. A key is never a *person*,
 * so it has no `site_users` grant to look up — its scopes are its grant.
 *
 * `collections:write` reaches `admin` because reshaping the content model is a site-admin power and
 * the schema routes check for exactly that. Issuing such a key is itself gated on being a site
 * admin (`routes/api-keys.ts`), so this cannot manufacture an authority its creator lacked.
 */
function roleForScopes(scopes: string[]): Role {
  if (scopes.includes('collections:write')) return 'admin'
  if (scopes.some((scope) => scope.endsWith(':write'))) return 'editor'
  return 'viewer'
}

/** True for a key issued to change things, as opposed to one that only serves a public website. */
const carriesWriteScope = (scopes: string[]) => scopes.some((scope) => scope.endsWith(':write'))

/**
 * Looks up the API key on the request, or `null` when there isn't one, it is unknown, or it has
 * expired. Never throws and never rejects — the role middlewares do that.
 */
async function apiKeyActor(c: Context<AppEnv>): Promise<Actor | null> {
  const header = c.req.header('authorization')
  const raw = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null
  if (!raw?.startsWith(API_KEY_PREFIX)) return null

  const db = getDb(c.env)
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, await hmac(c.env.AUTH_SECRET, raw)))
    .limit(1)

  if (!row) return null
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return null

  // Best-effort usage tracking; never block the request on it.
  c.executionCtx.waitUntil(
    db
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, row.id))
      .then(() => undefined),
  )

  return {
    kind: 'api_key',
    via: 'api_key',
    id: row.id,
    role: roleForScopes(row.scopes),
    // A key never has instance authority, whatever its scopes imply — it cannot reach a route that
    // checks a permission at all. Empty keeps `requirePermission` refusing it by construction.
    permissions: [],
    scopes: row.scopes,
    siteId: row.siteId,
  }
}

/**
 * Resolves a delivery API key from `Authorization: Bearer hdg_…`.
 *
 * Mounted on `/api/v1/content/*`. Any key reaches here, including a read-only one — that is what
 * the delivery API is for.
 */
export const resolveDeliveryActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('actor', await apiKeyActor(c))
  await next()
}

/**
 * Resolves either an admin session or a **write-scoped** API key, for the handful of management
 * routes a machine is meant to reach: content and media, never identity, tenancy or configuration
 * (`KEY_MANAGED_PREFIXES` in `index.ts`).
 *
 * The write-scope condition is the load-bearing part. A key carrying only `content:read` is the
 * credential that sits in a public website's environment variables — the least protected place any
 * Hedge credential lives — and it stays confined to `/api/v1/content/*`, which serves *published*
 * entries only. Without this condition that same key would reach `GET /collections/:c/entries` and
 * read every draft on the site.
 *
 * A key with a write scope is a different thing: an authoring credential a site admin created on
 * purpose, whose blast radius they chose. Both still pass the route's own role and scope checks.
 */
export const resolveSessionOrKeyActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = await apiKeyActor(c)

  if (key) {
    c.set('actor', carriesWriteScope(key.scopes) ? key : null)
    await next()
    return
  }

  return resolveSessionActor(c, next)
}
