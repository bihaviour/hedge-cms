import { ROLES, type User } from '@hedge/core'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import type { AppEnv } from '../env'
import { requireActor, requireRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

const toUser = (row: typeof users.$inferSelect): User & { pending: boolean } => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  createdAt: row.createdAt,
  pending: row.passwordHash === null,
})

app.get('/', requireRole('admin'), async (c) => {
  const db = getDb(c.env)
  const rows = await db.select().from(users).orderBy(asc(users.createdAt))
  return c.json({ data: rows.map(toUser) })
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
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, id))
    .returning()

  if (!row) throw ApiError.notFound('User')
  return c.json({ data: toUser(row) })
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
