import {
  approvalLevelForSiteRole,
  type InviteUserInput,
  type SiteAccess,
  type SiteRole,
  type User,
} from '@hedge/core'
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { accounts, sites, siteUsers, type UserRow, users } from '../db/schema'
import type { Bindings } from '../env'
import { ApiError } from './errors'
import { newId } from './id'
import { sendUserInvite } from './invites'
import { getRole, listRoles, permissionsForRole } from './roles'

/**
 * User and per-site-access management, factored out of the HTTP routes so the REST API and the MCP
 * endpoint share it.
 *
 * The guards in here are the ones that hold whoever the caller is — you cannot change your own
 * role, delete your own account, or delete the owner. They live at this level rather than in a
 * route because an agent acting through MCP is exactly the caller most likely to try, and the
 * check has to be in the path both surfaces take.
 */

export type PendingUser = User & { pending: boolean }

export function toUser(row: UserRow, pending = false, permissions: string[] = []): PendingUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions,
    createdAt: row.createdAt.toISOString(),
    pending,
  }
}

export async function findUser(env: Bindings, id: string): Promise<UserRow> {
  const [row] = await getDb(env).select().from(users).where(eq(users.id, id)).limit(1)
  if (!row) throw ApiError.notFound('User')
  return row
}

export async function listUsers(env: Bindings): Promise<PendingUser[]> {
  // "Pending" is the absence of a credential: an invited user has a row here from the moment they
  // are invited, but no password until they follow the link.
  const rows = await getDb(env)
    .select({ user: users, credential: accounts.id })
    .from(users)
    .leftJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, 'credential')))
    .orderBy(asc(users.createdAt))

  // One catalog for the whole list rather than a lookup per row: built-in roles resolve from code
  // and custom ones are a single small table, so this stays one query regardless of user count.
  const permissions = new Map((await listRoles(env)).map((role) => [role.slug, role.permissions]))

  return rows.map((row) =>
    toUser(row.user, row.credential === null, permissions.get(row.user.role) ?? []),
  )
}

/**
 * Creates the account and emails the link that lets them set a password. Nobody ever sets somebody
 * else's password here, so this is the only way a user is added.
 *
 * `siteId` is the site the invite was sent from: an editor or viewer with no grant would sign in to
 * nothing at all, so they start on that one. Owners and admins reach every site and get no grant.
 */
export async function inviteUser(
  env: Bindings,
  input: InviteUserInput,
  siteId: string,
): Promise<PendingUser> {
  const db = getDb(env)
  const email = input.email.toLowerCase()

  const role = await getRole(env, input.role)
  if (!role) throw ApiError.badRequest(`"${input.role}" is not a role`)

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  if (existing) throw ApiError.conflict('A user with that email already exists')

  const [user] = await db
    .insert(users)
    .values({ id: newId('usr'), email, name: input.name, role: input.role })
    .returning()

  // A role that reaches every site needs no grant; anything else would sign in to nothing at all,
  // so it starts on the site the invite was sent from, at that role's default site role.
  if (!role.permissions.includes('sites:access_all')) {
    await db
      .insert(siteUsers)
      .values({ siteId, userId: user!.id, role: role.defaultSiteRole ?? 'editor' })
  }

  await sendUserInvite(env, user!)
  return toUser(user!, false, role.permissions)
}

export async function updateUser(
  env: Bindings,
  id: string,
  input: { name?: string; role?: string },
  actorId: string,
): Promise<PendingUser> {
  if (input.role && id === actorId) {
    throw ApiError.badRequest('You cannot change your own role')
  }
  if (input.role !== undefined && !(await getRole(env, input.role))) {
    throw ApiError.badRequest(`"${input.role}" is not a role`)
  }

  const [row] = await getDb(env)
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning()

  if (!row) throw ApiError.notFound('User')
  return toUser(row, false, await permissionsForRole(env, row.role))
}

export async function deleteUser(env: Bindings, id: string, actorId: string): Promise<void> {
  if (id === actorId) throw ApiError.badRequest('You cannot delete your own account')

  const target = await findUser(env, id)
  if (target.role === 'owner') throw ApiError.forbidden('The owner account cannot be deleted')

  await getDb(env).delete(users).where(eq(users.id, id))
}

/* ------------------------------------------------------------------ *
 * Per-site access. Owners and admins reach every site, so they never appear here — these grants
 * are what give an editor or viewer a site at all.
 * ------------------------------------------------------------------ */

export async function listUserSites(env: Bindings, userId: string): Promise<SiteAccess[]> {
  const rows = await getDb(env)
    .select({
      siteId: sites.id,
      siteSlug: sites.slug,
      siteName: sites.name,
      role: siteUsers.role,
      approvalLevel: siteUsers.approvalLevel,
    })
    .from(siteUsers)
    .innerJoin(sites, eq(sites.id, siteUsers.siteId))
    .where(eq(siteUsers.userId, userId))
    .orderBy(asc(sites.name))

  // The effective level is resolved here rather than in the admin, so one rule decides it — the
  // same one `approvalLevelFor` applies when a decision is actually made.
  // `site_users.role` is a plain slug since #151, and this shape still reports one of the three.
  // Nothing assigns a custom site role yet; #157 is where this stops being a cast.
  return rows.map((row) => ({
    ...row,
    role: row.role as SiteRole,
    effectiveApprovalLevel: row.approvalLevel ?? approvalLevelForSiteRole(row.role as SiteRole),
  }))
}

export async function setUserSiteRole(
  env: Bindings,
  userId: string,
  siteId: string,
  role: SiteRole,
  approvalLevel?: number | null,
): Promise<SiteAccess> {
  const db = getDb(env)

  const user = await findUser(env, userId)

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1)
  if (!site) throw ApiError.notFound('Site')

  if ((await permissionsForRole(env, user.role)).includes('sites:access_all')) {
    throw ApiError.badRequest(`${user.name}'s role already reaches every site`)
  }

  // Omitting `approvalLevel` leaves whatever is stored alone — the admin's role dropdown and its
  // approval dropdown are two controls on one row, and changing one must not silently reset the other.
  const level = approvalLevel === undefined ? {} : { approvalLevel }

  const [row] = await db
    .insert(siteUsers)
    .values({ siteId, userId, role, ...level })
    .onConflictDoUpdate({
      target: [siteUsers.siteId, siteUsers.userId],
      set: { role, ...level },
    })
    .returning()

  return {
    siteId,
    siteSlug: site.slug,
    siteName: site.name,
    role,
    approvalLevel: row?.approvalLevel ?? null,
    effectiveApprovalLevel: row?.approvalLevel ?? approvalLevelForSiteRole(role),
  }
}

export async function removeUserSiteRole(
  env: Bindings,
  userId: string,
  siteId: string,
): Promise<void> {
  const [row] = await getDb(env)
    .delete(siteUsers)
    .where(and(eq(siteUsers.userId, userId), eq(siteUsers.siteId, siteId)))
    .returning({ userId: siteUsers.userId })

  if (!row) throw ApiError.notFound('Site access')
}
