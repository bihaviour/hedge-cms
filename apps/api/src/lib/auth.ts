import { type Role, roleAtLeast } from '@hedge/core'
import { and, asc, eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getCmsAuth } from '../auth/cms'
import { getDb } from '../db/client'
import { type SiteRow, sites, siteUsers, users } from '../db/schema'
import type { Actor, AppEnv, Bindings } from '../env'
import { hmac, randomToken } from './crypto'
import { ApiError } from './errors'
import { newId } from './id'
import { requireSite } from './site'

export const API_KEY_PREFIX = 'hdg_'

/**
 * Resolves the caller of a management route from their admin session cookie. Never rejects — it
 * sets `actor` to null and leaves the decision to `requireActor` and the role middlewares.
 *
 * Delivery API keys are deliberately not consulted here. They are resolved by
 * `lib/delivery-auth.ts`, which is mounted on `/api/v1/content/*` only, so a key minted to serve a
 * public website has no path into the management API at all.
 */
export const resolveSessionActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getCmsAuth(c.env).api.getSession({ headers: c.req.raw.headers })

  c.set(
    'actor',
    session
      ? {
          kind: 'user',
          via: 'session',
          id: session.user.id,
          role: session.user.role as Role,
          scopes: [],
          siteId: null,
        }
      : null,
  )
  await next()
}

export function requireActor(c: Context<AppEnv>): Actor {
  const actor = c.get('actor')
  if (!actor) throw ApiError.unauthorized()
  return actor
}

/** The signed-in user, rejecting API keys and delegated OAuth clients alike. */
export function requireUserActor(c: Context<AppEnv>): Actor {
  const actor = requireActor(c)
  if (actor.kind !== 'user' || actor.via !== 'session') {
    throw ApiError.forbidden('This endpoint requires a signed-in user')
  }
  return actor
}

/**
 * Instance-level authorisation: managing users and sites. Use `requireSiteRole` for anything
 * that belongs to one site — passing this alone would let a site admin invite users.
 */
export function requireRole(minimum: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = requireActor(c)
    if (!roleAtLeast(actor.role, minimum)) {
      throw ApiError.forbidden(`Requires ${minimum} role or higher`)
    }
    await next()
  }
}

/**
 * The caller's role on one site, or `null` when they have none.
 *
 * Owners and admins run the instance and reach every site. For everyone else the grant in
 * `site_users` *is* their access — their `users.role` is only the default they were granted
 * with, and a grant can raise or lower it per site. API keys are bound to a single site.
 */
export async function siteRoleFor(
  env: Bindings,
  actor: Actor,
  siteId: string,
): Promise<Role | null> {
  if (actor.kind === 'api_key') return actor.siteId === siteId ? actor.role : null
  if (roleAtLeast(actor.role, 'admin')) return actor.role

  const [grant] = await getDb(env)
    .select({ role: siteUsers.role })
    .from(siteUsers)
    .where(and(eq(siteUsers.siteId, siteId), eq(siteUsers.userId, actor.id)))
    .limit(1)

  return grant?.role ?? null
}

/** Same, memoised for the current request — several middlewares ask this per route. */
export async function currentSiteRole(c: Context<AppEnv>): Promise<Role | null> {
  const cached = c.get('siteRole')
  if (cached !== undefined) return cached

  const role = await siteRoleFor(c.env, requireActor(c), requireSite(c).id)
  c.set('siteRole', role)
  return role
}

/** Per-site authorisation. Everything that reads or writes one site's content goes through it. */
export function requireSiteRole(minimum: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const site = requireSite(c)
    const role = await currentSiteRole(c)

    if (!role) throw ApiError.forbidden(`You do not have access to the "${site.slug}" site`)
    if (!roleAtLeast(role, minimum)) {
      throw ApiError.forbidden(`Requires ${minimum} access to the "${site.slug}" site`)
    }
    await next()
  }
}

/** The sites this caller can reach, newest name first. Drives the admin's site switcher. */
export async function accessibleSites(env: Bindings, actor: Actor): Promise<SiteRow[]> {
  const db = getDb(env)

  if (actor.kind === 'api_key') {
    return actor.siteId ? await db.select().from(sites).where(eq(sites.id, actor.siteId)) : []
  }

  if (roleAtLeast(actor.role, 'admin')) {
    return await db.select().from(sites).orderBy(asc(sites.name))
  }

  const rows = await db
    .select({ site: sites })
    .from(siteUsers)
    .innerJoin(sites, eq(sites.id, siteUsers.siteId))
    .where(eq(siteUsers.userId, actor.id))
    .orderBy(asc(sites.name))

  return rows.map((row) => row.site)
}

/**
 * Scope enforcement for credentials that carry scopes. A signed-in user has none — they are
 * governed by roles — but an API key or a delegated OAuth client is limited to what it was issued
 * for, on top of whatever role check the route already applied.
 */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = requireActor(c)
    if (actor.via !== 'session' && !actor.scopes.includes(scope)) {
      throw ApiError.forbidden(`The credential is missing the "${scope}" scope`)
    }
    await next()
  }
}

/** The role a user has on a site, looked up for a caller resolved outside the session middleware. */
export async function userRole(env: Bindings, userId: string): Promise<Role | null> {
  const [row] = await getDb(env)
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.role ?? null
}

/** Generates an API key, returning the raw value (shown once) and the row to persist. */
export async function generateApiKey(
  env: Bindings,
  siteId: string,
  name: string,
  scopes: string[],
) {
  const raw = `${API_KEY_PREFIX}${randomToken(24)}`
  return {
    raw,
    row: {
      id: newId('key'),
      siteId,
      name,
      prefix: raw.slice(0, 12),
      keyHash: await hmac(env.AUTH_SECRET, raw),
      scopes,
    },
  }
}
