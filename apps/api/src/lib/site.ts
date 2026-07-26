import { AsyncLocalStorage } from 'node:async_hooks'
import { SITE_HEADER } from '@hedge/core'
import { count, eq, or } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getDb } from '../db/client'
import { type SiteRow, sites } from '../db/schema'
import type { AppEnv } from '../env'
import { ApiError } from './errors'

/**
 * Works out which site a request is for. In order:
 *
 *   1. the `X-Hedge-Site` header — a slug or an id, sent by the admin's site switcher
 *   2. a `?site=` query parameter, for links and quick curls
 *   3. the site the calling API key was issued for
 *   4. a `Host` match against `sites.domain`, so a website can call in without configuration
 *   5. the only site there is, when the deployment has exactly one
 *
 * An explicit selector that matches nothing is a 404 rather than a silent fallback — a typo in
 * the header must never quietly serve another tenant's content.
 */
async function lookupSite(c: Context<AppEnv>): Promise<SiteRow | null> {
  const db = getDb(c.env)
  const actor = c.get('actor')

  const selector = c.req.header(SITE_HEADER)?.trim() || c.req.query('site')?.trim()

  if (selector) {
    const [row] = await db
      .select()
      .from(sites)
      .where(or(eq(sites.slug, selector), eq(sites.id, selector)))
      .limit(1)
    if (!row) throw ApiError.unknownSite(selector)

    // An API key is bound to one site and cannot be pointed at another by header.
    if (actor?.kind === 'api_key' && actor.siteId !== row.id) {
      throw ApiError.forbidden('This API key was issued for a different site')
    }
    return row
  }

  if (actor?.kind === 'api_key' && actor.siteId) {
    const [row] = await db.select().from(sites).where(eq(sites.id, actor.siteId)).limit(1)
    return row ?? null
  }

  const host = c.req.header('host')?.split(':')[0]?.toLowerCase()
  if (host) {
    const [row] = await db.select().from(sites).where(eq(sites.domain, host)).limit(1)
    if (row) return row
  }

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(sites)
  if (total === 1) {
    const [row] = await db.select().from(sites).limit(1)
    return row ?? null
  }

  return null
}

/**
 * The site the request in flight resolved to, for code that cannot be handed the Hono context.
 *
 * There is exactly one such caller: Better Auth's email callbacks in `auth/member.ts`. They run
 * inside `auth.api.*`, are given only what Better Auth passes them, and the instance itself is
 * cached per isolate — so there is no parameter a site could travel through. A member's invite,
 * reset and verification email all belong to the site they are signing in to, and that is request
 * state, so it lives here for the duration of the request rather than in a header a caller could
 * set. Everywhere else knows its site explicitly and should pass it explicitly.
 */
const requestSite = new AsyncLocalStorage<SiteRow | null>()

export function currentRequestSite(): SiteRow | null {
  return requestSite.getStore() ?? null
}

/** Resolves the site for every request. Never rejects on its own — `requireSite` does that. */
export const resolveSite: MiddlewareHandler<AppEnv> = async (c, next) => {
  const site = await lookupSite(c)
  c.set('site', site)
  await requestSite.run(site, next)
}

export function requireSite(c: Context<AppEnv>): SiteRow {
  const site = c.get('site')
  if (!site) {
    throw ApiError.badRequest(`No site selected — send a site slug in the "${SITE_HEADER}" header`)
  }
  return site
}
