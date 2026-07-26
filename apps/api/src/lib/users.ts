import {
  type InviteUserInput,
  type Role,
  roleAtLeast,
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

export function toUser(row: UserRow, pending = false): PendingUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
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

  return rows.map((row) => toUser(row.user, row.credential === null))
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

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  if (existing) throw ApiError.conflict('A user with that email already exists')

  const [user] = await db
    .insert(users)
    .values({ id: newId('usr'), email, name: input.name, role: input.role })
    .returning()

  if (input.role === 'editor' || input.role === 'viewer') {
    await db.insert(siteUsers).values({ siteId, userId: user!.id, role: input.role })
  }

  await sendUserInvite(env, user!)
  return toUser(user!)
}

export async function updateUser(
  env: Bindings,
  id: string,
  input: { name?: string; role?: Role },
  actorId: string,
): Promise<PendingUser> {
  if (input.role && id === actorId) {
    throw ApiError.badRequest('You cannot change your own role')
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
  return toUser(row)
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
  return await getDb(env)
    .select({
      siteId: sites.id,
      siteSlug: sites.slug,
      siteName: sites.name,
      role: siteUsers.role,
    })
    .from(siteUsers)
    .innerJoin(sites, eq(sites.id, siteUsers.siteId))
    .where(eq(siteUsers.userId, userId))
    .orderBy(asc(sites.name))
}

export async function setUserSiteRole(
  env: Bindings,
  userId: string,
  siteId: string,
  role: SiteRole,
): Promise<{ siteId: string; userId: string; role: SiteRole }> {
  const db = getDb(env)

  const user = await findUser(env, userId)

  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).limit(1)
  if (!site) throw ApiError.notFound('Site')

  if (roleAtLeast(user.role, 'admin')) {
    throw ApiError.badRequest(
      `${user.name} is an instance ${user.role} and already reaches every site`,
    )
  }

  await db
    .insert(siteUsers)
    .values({ siteId, userId, role })
    .onConflictDoUpdate({ target: [siteUsers.siteId, siteUsers.userId], set: { role } })

  return { siteId, userId, role }
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
