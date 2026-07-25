import {
  acceptInviteSchema,
  inviteUserSchema,
  loginSchema,
  passwordSchema,
  type User,
} from '@hedge/core'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { authTokens, sites, siteUsers, users } from '../db/schema'
import { sendEmail } from '../email/send'
import { inviteEmail, passwordResetEmail } from '../email/templates'
import type { AppEnv } from '../env'
import { createSession, destroySession, requireActor, requireRole } from '../lib/auth'
import { hashPassword, hmac, randomToken, verifyPassword } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7
const RESET_TTL_SECONDS = 60 * 60

const app = new Hono<AppEnv>()

const toUser = (row: typeof users.$inferSelect): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  createdAt: row.createdAt,
})

app.post('/login', async (c) => {
  const { email, password } = await validate(c, loginSchema)
  const db = getDb(c.env)

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)

  // Always run a hash comparison so a missing account and a wrong password take similar time.
  const valid = user?.passwordHash
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, await hashPassword(randomToken(8)))

  if (!user || !valid) throw ApiError.unauthorized('Incorrect email or password')

  await createSession(c, user.id)
  return c.json({ data: toUser(user) })
})

app.post('/logout', async (c) => {
  await destroySession(c)
  return c.json({ data: { ok: true } })
})

app.get('/me', async (c) => {
  const actor = requireActor(c)
  if (actor.kind !== 'user') throw ApiError.forbidden('API keys cannot access the admin session')

  const db = getDb(c.env)
  const [user] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1)
  if (!user) throw ApiError.notFound('User')

  return c.json({ data: toUser(user) })
})

/**
 * Bootstraps the very first owner account. Only works while the users table is empty, so it
 * is safe to leave enabled — after setup it returns 409 for everyone.
 */
app.post('/setup', async (c) => {
  const input = await validate(
    c,
    z.object({
      email: z.email(),
      name: z.string().min(1).max(120),
      password: passwordSchema,
    }),
  )

  const db = getDb(c.env)
  const [existing] = await db.select({ id: users.id }).from(users).limit(1)
  if (existing) throw ApiError.conflict('This instance has already been set up')

  // Content needs a tenant to live in, so the first run also creates the first site.
  const [firstSite] = await db.select({ id: sites.id }).from(sites).limit(1)
  if (!firstSite) {
    await db.insert(sites).values({
      id: newId('sit'),
      slug: 'default',
      name: 'Default site',
      description: 'Rename this, or add more sites under Settings → Sites.',
    })
  }

  const [user] = await db
    .insert(users)
    .values({
      id: newId('usr'),
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: 'owner',
    })
    .returning()

  await createSession(c, user!.id)
  return c.json({ data: toUser(user!) }, 201)
})

app.get('/setup-required', async (c) => {
  const db = getDb(c.env)
  const [existing] = await db.select({ id: users.id }).from(users).limit(1)
  return c.json({ data: { setupRequired: !existing } })
})

app.post('/invite', requireRole('admin'), async (c) => {
  const input = await validate(c, inviteUserSchema)
  const db = getDb(c.env)
  const email = input.email.toLowerCase()

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  if (existing) throw ApiError.conflict('A user with that email already exists')

  const [user] = await db
    .insert(users)
    .values({ id: newId('usr'), email, name: input.name, role: input.role })
    .returning()

  // Owners and admins reach every site. Everyone else needs a grant or they would sign in to
  // nothing at all, so start them on the site the invite was sent from.
  if (input.role === 'editor' || input.role === 'viewer') {
    await db
      .insert(siteUsers)
      .values({ siteId: requireSite(c).id, userId: user!.id, role: input.role })
  }

  const token = randomToken(32)
  await db.insert(authTokens).values({
    id: newId('tok'),
    userId: user!.id,
    purpose: 'invite',
    tokenHash: await hmac(c.env.AUTH_SECRET, token),
    expiresAt: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
  })

  await sendEmail(c.env, inviteEmail(c.env, { to: email, name: input.name, token }))
  return c.json({ data: toUser(user!) }, 201)
})

app.post('/accept-invite', async (c) => {
  const input = await validate(c, acceptInviteSchema)
  const db = getDb(c.env)

  const [row] = await db
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, await hmac(c.env.AUTH_SECRET, input.token)),
        eq(authTokens.purpose, 'invite'),
        isNull(authTokens.usedAt),
      ),
    )
    .limit(1)

  if (!row || row.expiresAt < Math.floor(Date.now() / 1000)) {
    throw ApiError.badRequest('This invite link is invalid or has expired')
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.password), updatedAt: new Date().toISOString() })
    .where(eq(users.id, row.userId))
  await db
    .update(authTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(eq(authTokens.id, row.id))

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1)
  await createSession(c, row.userId)
  return c.json({ data: toUser(user!) })
})

app.post('/forgot-password', async (c) => {
  const { email } = await validate(c, z.object({ email: z.email() }))
  const db = getDb(c.env)

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)

  // Respond identically whether or not the account exists, so this cannot enumerate users.
  if (user) {
    const token = randomToken(32)
    await db.insert(authTokens).values({
      id: newId('tok'),
      userId: user.id,
      purpose: 'password_reset',
      tokenHash: await hmac(c.env.AUTH_SECRET, token),
      expiresAt: Math.floor(Date.now() / 1000) + RESET_TTL_SECONDS,
    })
    await sendEmail(c.env, passwordResetEmail(c.env, { to: user.email, name: user.name, token }))
  }

  return c.json({ data: { ok: true } })
})

app.post('/reset-password', async (c) => {
  const input = await validate(c, z.object({ token: z.string().min(1), password: passwordSchema }))
  const db = getDb(c.env)

  const [row] = await db
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, await hmac(c.env.AUTH_SECRET, input.token)),
        eq(authTokens.purpose, 'password_reset'),
        isNull(authTokens.usedAt),
      ),
    )
    .limit(1)

  if (!row || row.expiresAt < Math.floor(Date.now() / 1000)) {
    throw ApiError.badRequest('This reset link is invalid or has expired')
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.password), updatedAt: new Date().toISOString() })
    .where(eq(users.id, row.userId))
  await db
    .update(authTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(eq(authTokens.id, row.id))

  return c.json({ data: { ok: true } })
})

export default app
