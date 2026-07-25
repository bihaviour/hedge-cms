import { type Role, roleAtLeast, SESSION_COOKIE } from '@hedge/core'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { getDb } from '../db/client'
import { apiKeys, type SiteRow, sessions, sites, siteUsers, users } from '../db/schema'
import type { Actor, AppEnv, Bindings } from '../env'
import { hmac, randomToken } from './crypto'
import { ApiError } from './errors'
import { newId } from './id'
import { requireSite } from './site'

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
export const API_KEY_PREFIX = 'hdg_'

/** Creates a session row and sets the cookie. Returns the raw token given to the browser. */
export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const token = randomToken(32)
  const db = getDb(c.env)
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS

  await db.insert(sessions).values({
    id: await hmac(c.env.AUTH_SECRET, token),
    userId,
    expiresAt,
  })

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })

  return token
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    const db = getDb(c.env)
    await db.delete(sessions).where(eq(sessions.id, await hmac(c.env.AUTH_SECRET, token)))
  }
  setCookie(c, SESSION_COOKIE, '', { path: '/', maxAge: 0 })
}

async function actorFromSession(c: Context<AppEnv>): Promise<Actor | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null

  const db = getDb(c.env)
  const now = Math.floor(Date.now() / 1000)
  const [row] = await db
    .select({ userId: users.id, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, await hmac(c.env.AUTH_SECRET, token)), gt(sessions.expiresAt, now)))
    .limit(1)

  if (!row) return null
  return { kind: 'user', id: row.userId, role: row.role, scopes: [], siteId: null }
}

async function actorFromApiKey(c: Context<AppEnv>): Promise<Actor | null> {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) return null

  const raw = header.slice('Bearer '.length).trim()
  if (!raw.startsWith(API_KEY_PREFIX)) return null

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

  const canWrite = row.scopes.some((scope) => scope.endsWith(':write'))
  return {
    kind: 'api_key',
    id: row.id,
    role: canWrite ? 'editor' : 'viewer',
    scopes: row.scopes,
    siteId: row.siteId,
  }
}

/** Resolves the caller from a session cookie or API key. Never rejects — sets `actor` to null. */
export const resolveActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = (await actorFromSession(c)) ?? (await actorFromApiKey(c))
  c.set('actor', actor)
  await next()
}

export function requireActor(c: Context<AppEnv>): Actor {
  const actor = c.get('actor')
  if (!actor) throw ApiError.unauthorized()
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

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = requireActor(c)
    // Signed-in users are governed by roles, not scopes.
    if (actor.kind === 'api_key' && !actor.scopes.includes(scope)) {
      throw ApiError.forbidden(`API key is missing the "${scope}" scope`)
    }
    await next()
  }
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
