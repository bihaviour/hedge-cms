import {
  ALL_SITE_PERMISSIONS,
  approvalLevelForSiteRole,
  hasSitePermission,
  type InstancePermission,
  type Role,
  type SitePermission,
  type SitePermissionSurface,
} from '@hedge/core'
import { and, asc, eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getCmsAuth } from '../auth/cms'
import { getDb } from '../db/client'
import { roles, type SiteRow, sites, siteUsers, users } from '../db/schema'
import type { Actor, AppEnv, Bindings } from '../env'
import { hmac, randomToken } from './crypto'
import { ApiError } from './errors'
import { newId } from './id'
import { matrixForSlug, permissionsForRole } from './roles'
import { requireSite } from './site'

export const API_KEY_PREFIX = 'hdg_'

/**
 * Resolves the caller of a management route from their admin session cookie. Never rejects — it
 * sets `actor` to null and leaves the decision to `requireActor` and the role middlewares.
 *
 * API keys are deliberately not consulted here. A read-only key — the credential a public website
 * holds — is resolved only on `/api/v1/content/*`, and a write-scoped one only on the content and
 * media routes listed as `KEY_MANAGED_PREFIXES`. Both live in `lib/delivery-auth.ts`, so no key of
 * any kind reaches users, sites, members, email or the key routes themselves.
 */
export const resolveSessionActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getCmsAuth(c.env).api.getSession({ headers: c.req.raw.headers })

  if (!session) {
    c.set('actor', null)
    await next()
    return
  }

  // `users.role` is NOT NULL with a default, so a signed-in user always has one; the `?? 'editor'`
  // only satisfies Better Auth's looser type. The slug tells us who they are; its permission set is
  // what every instance check reads — resolved once, free for built-in roles and one lookup for custom.
  const role = session.user.role ?? 'editor'
  c.set('actor', {
    kind: 'user',
    via: 'session',
    id: session.user.id,
    role,
    permissions: await permissionsForRole(c.env, role),
    scopes: [],
    siteId: null,
  })
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
 * Instance-level authorisation: managing users, sites, email and the roles themselves. Use
 * `requireSitePermission` for anything that belongs to one site — passing this alone would let a
 * site admin invite users.
 *
 * The check is set membership against the caller's role permissions, not a rank: a role carries
 * exactly the powers it was defined with. An API key never satisfies this, whatever its scopes
 * imply — instance authority is about a person running the deployment, and a key is only ever a
 * statement about one site.
 */
export function requirePermission(permission: InstancePermission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = requireActor(c)
    if (actor.kind === 'api_key') {
      throw ApiError.forbidden('This endpoint requires a signed-in user')
    }
    if (!actor.permissions.includes(permission)) {
      throw ApiError.forbidden(`Requires the "${permission}" permission`)
    }
    await next()
  }
}

/**
 * The caller's role on one site, or `null` when they have none.
 *
 * A user whose instance role carries `sites:access_all` reaches every site as a site admin. For
 * everyone else the grant in `site_users` *is* their access — their `users.role` is only the
 * default they were invited with, and a grant can raise or lower it per site. API keys are bound
 * to a single site.
 */
export async function siteRoleFor(
  env: Bindings,
  actor: Actor,
  siteId: string,
): Promise<Role | null> {
  if (actor.kind === 'api_key') return actor.siteId === siteId ? (actor.role as Role) : null
  if (actor.permissions.includes('sites:access_all')) return 'admin'

  const [grant] = await getDb(env)
    .select({ role: siteUsers.role })
    .from(siteUsers)
    .where(and(eq(siteUsers.siteId, siteId), eq(siteUsers.userId, actor.id)))
    .limit(1)

  // The column is a plain slug since #151, so a deployment with a custom site role could return one
  // that is not on the `admin > editor > viewer` ladder. Nothing assigns one yet — `setSiteRoleSchema`
  // is still the three — and what remains of this function is display and approval level, both of
  // which #157 moves onto the set. Until then the cast says what is true today.
  return (grant?.role as Role) ?? null
}

/** Same, memoised for the current request — several middlewares ask this per route. */
export async function currentSiteRole(c: Context<AppEnv>): Promise<Role | null> {
  const cached = c.get('siteRole')
  if (cached !== undefined) return cached

  const role = await siteRoleFor(c.env, requireActor(c), requireSite(c).id)
  c.set('siteRole', role)
  return role
}

/**
 * What this caller may do on one site, verb by verb — `null` when they may not reach it at all
 * (#151). The set replaces the rank; `siteRoleFor` above still answers *which* role they hold,
 * which is what the admin displays and what approval level derives from.
 *
 * Three answers, and the order matters:
 *
 * - an **API key** carries the matrix of the role its scopes imply, on its own site and no other.
 *   Unchanged from the rank it resolved to before; #156 is what makes a key follow its *issuer's*
 *   delegated column instead.
 * - an instance role carrying **`sites:access_all`** resolves to every permission, on every site,
 *   with no grant row involved. This is the floor the whole epic rests on: no edit to any matrix
 *   can lock a deployment out of itself, by construction rather than by a special case.
 * - otherwise the **grant** in `site_users` names a role slug, and that role's matrix is the answer.
 *
 * `surface` picks the column: what the person may do, or what they delegate to an MCP client or to
 * a key. A delegated column is a subset of `site` — enforced when the role is written, not here.
 */
export async function sitePermissionsFor(
  env: Bindings,
  actor: Actor,
  siteId: string,
  surface: SitePermissionSurface = 'site',
): Promise<readonly SitePermission[] | null> {
  if (actor.kind === 'api_key') {
    if (actor.siteId !== siteId) return null
    return matrixForSlug(await roleRowFor(env, actor.role), actor.role)[surface]
  }

  if (actor.permissions.includes('sites:access_all')) return ALL_SITE_PERMISSIONS

  const [grant] = await getDb(env)
    .select({ role: siteUsers.role, definition: roles })
    .from(siteUsers)
    .leftJoin(roles, eq(roles.slug, siteUsers.role))
    .where(and(eq(siteUsers.siteId, siteId), eq(siteUsers.userId, actor.id)))
    .limit(1)

  if (!grant) return null
  return matrixForSlug(grant.definition ?? undefined, grant.role)[surface]
}

/** One role row by slug, for the paths that have no `site_users` join to hang it off. */
async function roleRowFor(env: Bindings, slug: string) {
  const [row] = await getDb(env).select().from(roles).where(eq(roles.slug, slug)).limit(1)
  return row
}

/**
 * The `site` column, memoised for the current request. Every gate on a management route asks this,
 * and a route often runs two of them.
 */
export async function currentSitePermissions(
  c: Context<AppEnv>,
): Promise<readonly SitePermission[] | null> {
  const cached = c.get('sitePermissions')
  if (cached !== undefined) return cached

  const permissions = await sitePermissionsFor(c.env, requireActor(c), requireSite(c).id)
  c.set('sitePermissions', permissions)
  return permissions
}

/**
 * Per-site authorisation, one verb at a time. Everything that reads or writes one site's content
 * goes through it — `requireSitePermission('entries:delete')` is a different question from
 * `requireSitePermission('entries:update')`, which is the whole of #151.
 */
export function requireSitePermission(permission: SitePermission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const site = requireSite(c)
    const permissions = await currentSitePermissions(c)

    if (!permissions) throw ApiError.forbidden(`You do not have access to the "${site.slug}" site`)
    if (!hasSitePermission(permissions, permission)) {
      throw ApiError.forbidden(`Requires "${permission}" on the "${site.slug}" site`)
    }
    await next()
  }
}

// `requireSiteRole` was here, and #154 removed it: every site route names the verb it needs, so
// there is nothing left for a rank to answer. `roleAtLeast` survives for the *instance* ordering,
// which is still an ordering — `owner > admin > editor > viewer` is about a deployment, not a site.

/**
 * What this caller may approve on one site — 0 for nothing, 1 or 2 for the levels an entry version
 * has to clear before it can be published.
 *
 * Three answers, in order:
 *
 * - an **API key or a delegated client** approves nothing, ever. Authoring a version is something a
 *   machine may do; blessing one is a statement by a person, and the credential that can author is
 *   the one most likely to be automated. The approval routes reject them outright as well, on the
 *   same reasoning `requirePermission` rejects keys — this is the belt to that pair of braces.
 * - the **explicit override** on their `site_users` grant, when one is set.
 * - otherwise the **site role's default**, which is also the answer for a user who reaches the site
 *   through `sites:access_all` and therefore has no grant row at all: they resolve to site admin,
 *   and site admin derives level 2.
 */
export async function approvalLevelFor(
  env: Bindings,
  actor: Actor,
  siteId: string,
): Promise<number> {
  if (actor.kind !== 'user' || actor.via !== 'session') return 0

  const role = await siteRoleFor(env, actor, siteId)
  if (!role) return 0

  const [grant] = await getDb(env)
    .select({ level: siteUsers.approvalLevel })
    .from(siteUsers)
    .where(and(eq(siteUsers.siteId, siteId), eq(siteUsers.userId, actor.id)))
    .limit(1)

  return grant?.level ?? approvalLevelForSiteRole(role)
}

/** The sites this caller can reach, newest name first. Drives the admin's site switcher. */
export async function accessibleSites(env: Bindings, actor: Actor): Promise<SiteRow[]> {
  const db = getDb(env)

  if (actor.kind === 'api_key') {
    return actor.siteId ? await db.select().from(sites).where(eq(sites.id, actor.siteId)) : []
  }

  if (actor.permissions.includes('sites:access_all')) {
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

/** A user's role *slug*, looked up for a caller resolved outside the session middleware (MCP). */
export async function userRole(env: Bindings, userId: string): Promise<string | null> {
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
