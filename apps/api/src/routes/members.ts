import {
  createMemberSchema,
  type Member,
  memberLoginSchema,
  memberRegisterSchema,
  updateMemberSchema,
} from '@hedge/core'
import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { type MemberRow, members } from '../db/schema'
import type { AppEnv } from '../env'
import { requireSiteRole } from '../lib/auth'
import { hashPassword, randomToken, verifyPassword } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { createMemberSession, destroyMemberSession, requireMember } from '../lib/member-auth'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    siteId: row.siteId,
    email: row.email,
    name: row.name,
    status: row.status,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  }
}

/* ------------------------------------------------------------------ *
 * Public member auth, mounted at /api/v1/member.
 *
 * These are the only routes a website visitor ever touches. They are site-scoped, take no
 * session cookie, and hand back a bearer token the calling site stores for its visitor.
 * ------------------------------------------------------------------ */

export const memberAuth = new Hono<AppEnv>()

memberAuth.post('/register', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, memberRegisterSchema)
  const db = getDb(c.env)
  const email = input.email.toLowerCase()

  if (!site.allowMemberSignup) {
    throw ApiError.forbidden('This site is invite-only — ask an editor to add you')
  }

  const [existing] = await db
    .select()
    .from(members)
    .where(and(eq(members.siteId, site.id), eq(members.email, email)))
    .limit(1)

  // An admin can add a member ahead of time; registering with that email claims the account.
  if (existing?.passwordHash) throw ApiError.conflict('An account with that email already exists')
  if (existing?.status === 'blocked') throw ApiError.forbidden('This account has been blocked')

  const passwordHash = await hashPassword(input.password)
  const now = new Date().toISOString()

  const [row] = existing
    ? await db
        .update(members)
        .set({ name: input.name, passwordHash, updatedAt: now })
        .where(eq(members.id, existing.id))
        .returning()
    : await db
        .insert(members)
        .values({ id: newId('mem'), siteId: site.id, email, name: input.name, passwordHash })
        .returning()

  const session = await createMemberSession(c, row!.id)
  return c.json({ data: { ...session, member: toMember(row!) } }, 201)
})

memberAuth.post('/login', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, memberLoginSchema)
  const db = getDb(c.env)

  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.siteId, site.id), eq(members.email, input.email.toLowerCase())))
    .limit(1)

  // Always hash, so a missing account and a wrong password take similar time.
  const valid = member?.passwordHash
    ? await verifyPassword(input.password, member.passwordHash)
    : await verifyPassword(input.password, await hashPassword(randomToken(8)))

  if (!member || !valid) throw ApiError.unauthorized('Incorrect email or password')
  if (member.status === 'blocked') throw ApiError.forbidden('This account has been blocked')

  const now = new Date().toISOString()
  await db.update(members).set({ lastLoginAt: now }).where(eq(members.id, member.id))

  const session = await createMemberSession(c, member.id)
  return c.json({ data: { ...session, member: toMember({ ...member, lastLoginAt: now }) } })
})

memberAuth.post('/logout', async (c) => {
  await destroyMemberSession(c)
  return c.json({ data: { ok: true } })
})

memberAuth.get('/me', async (c) => {
  requireSite(c)
  return c.json({ data: toMember(requireMember(c)) })
})

/* ------------------------------------------------------------------ *
 * Admin management, mounted at /api/v1/members. Scoped to the current site.
 * ------------------------------------------------------------------ */

const app = new Hono<AppEnv>()

app.get('/', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const query = validateQuery(
    c,
    z.object({
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
  )

  const filters: SQL[] = [eq(members.siteId, site.id)]
  if (query.q) filters.push(like(members.email, `%${query.q.toLowerCase()}%`))
  if (query.cursor) filters.push(lt(members.id, query.cursor))

  const rows = await getDb(c.env)
    .select()
    .from(members)
    .where(and(...filters))
    .orderBy(desc(members.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows

  return c.json({
    data: page.map(toMember),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  })
})

app.post('/', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, createMemberSchema)
  const db = getDb(c.env)
  const email = input.email.toLowerCase()

  const [existing] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.siteId, site.id), eq(members.email, email)))
  if (existing) throw ApiError.conflict('That email is already a member of this site')

  const [row] = await db
    .insert(members)
    .values({
      id: newId('mem'),
      siteId: site.id,
      email,
      name: input.name,
      // Left null when no password is given: the member sets one by registering.
      passwordHash: input.password ? await hashPassword(input.password) : null,
    })
    .returning()

  return c.json({ data: toMember(row!) }, 201)
})

app.patch('/:id', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, updateMemberSchema)

  const [row] = await getDb(c.env)
    .update(members)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(members.id, c.req.param('id')), eq(members.siteId, site.id)))
    .returning()

  if (!row) throw ApiError.notFound('Member')
  return c.json({ data: toMember(row) })
})

app.delete('/:id', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)

  // Sessions cascade with the member, so deleting one signs them out everywhere.
  const [row] = await getDb(c.env)
    .delete(members)
    .where(and(eq(members.id, c.req.param('id')), eq(members.siteId, site.id)))
    .returning({ id: members.id })

  if (!row) throw ApiError.notFound('Member')
  return c.body(null, 204)
})

export default app
