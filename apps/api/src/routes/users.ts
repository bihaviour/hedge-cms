import { ROLES, roleAtLeast, type SiteAccess, setSiteRoleSchema, type User } from '@hedge/core'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { accounts, sites, siteUsers, users } from '../db/schema'
import type { AppEnv } from '../env'
import { requireActor, requireRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

const toUser = (row: typeof users.$inferSelect, pending = false): User & { pending: boolean } => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
  pending,
})

app.get('/', requireRole('admin'), async (c) => {
  const db = getDb(c.env)

  // "Pending" is now the absence of a credential: an invited user has a row here from the moment
  // they are invited, but no password until they follow the link.
  const rows = await db
    .select({ user: users, credential: accounts.id })
    .from(users)
    .leftJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, 'credential')))
    .orderBy(asc(users.createdAt))

  return c.json({ data: rows.map((row) => toUser(row.user, row.credential === null)) })
})

app.patch('/:id', requireRole('admin'), async (c) => {
  const input = await validate(
    c,
    z.object({
      name: z.string().min(1).max(120).optional(),
      role: z.enum(ROLES).optional(),
    }),
  )
  const actor = requireActor(c)
  const db = getDb(c.env)
  const id = c.req.param('id')

  if (input.role && id === actor.id) {
    throw ApiError.badRequest('You cannot change your own role')
  }

  const [row] = await db
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning()

  if (!row) throw ApiError.notFound('User')
  return c.json({ data: toUser(row) })
})

/* ------------------------------------------------------------------ *
 * Per-site access. Owners and admins reach every site, so they never appear here — these
 * grants are what give an editor or viewer a site at all.
 * ------------------------------------------------------------------ */

/** The sites this user has been granted, for the admin's access editor. */
app.get('/:id/sites', requireRole('admin'), async (c) => {
  const db = getDb(c.env)
  const rows = await db
    .select({
      siteId: sites.id,
      siteSlug: sites.slug,
      siteName: sites.name,
      role: siteUsers.role,
    })
    .from(siteUsers)
    .innerJoin(sites, eq(sites.id, siteUsers.siteId))
    .where(eq(siteUsers.userId, c.req.param('id')))
    .orderBy(asc(sites.name))

  return c.json({ data: rows satisfies SiteAccess[] })
})

app.put('/:id/sites/:siteId', requireRole('admin'), async (c) => {
  const { role } = await validate(c, setSiteRoleSchema)
  const db = getDb(c.env)
  const userId = c.req.param('id')
  const siteId = c.req.param('siteId')

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw ApiError.notFound('User')

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

  return c.json({ data: { siteId, userId, role } })
})

app.delete('/:id/sites/:siteId', requireRole('admin'), async (c) => {
  const [row] = await getDb(c.env)
    .delete(siteUsers)
    .where(
      and(eq(siteUsers.userId, c.req.param('id')), eq(siteUsers.siteId, c.req.param('siteId'))),
    )
    .returning({ userId: siteUsers.userId })

  if (!row) throw ApiError.notFound('Site access')
  return c.body(null, 204)
})

app.delete('/:id', requireRole('admin'), async (c) => {
  const actor = requireActor(c)
  const id = c.req.param('id')
  if (id === actor.id) throw ApiError.badRequest('You cannot delete your own account')

  const db = getDb(c.env)
  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  if (!target) throw ApiError.notFound('User')
  if (target.role === 'owner') throw ApiError.forbidden('The owner account cannot be deleted')

  await db.delete(users).where(eq(users.id, id))
  return c.body(null, 204)
})

export default app
