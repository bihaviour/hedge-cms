import {
  type AuthorizedClient,
  acceptInviteSchema,
  inviteUserSchema,
  loginSchema,
  passwordSchema,
  type User,
  type UserSession,
} from '@hedge/core'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getCmsAuth } from '../auth/cms'
import { applyCookies, forwardToAuth } from '../auth/forward'
import { getDb } from '../db/client'
import {
  accounts,
  authTokens,
  oauthAccessTokens,
  oauthApplications,
  oauthConsents,
  sessions,
  sites,
  siteUsers,
  users,
} from '../db/schema'
import { sendEmail } from '../email/send'
import { inviteEmail } from '../email/templates'
import type { AppEnv } from '../env'
import { requireActor, requireRole, requireUserActor } from '../lib/auth'
import { hashPassword, hmac, randomToken } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7

const app = new Hono<AppEnv>()

const toUser = (row: typeof users.$inferSelect): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
})

async function userById(env: AppEnv['Bindings'], id: string) {
  const [row] = await getDb(env).select().from(users).where(eq(users.id, id)).limit(1)
  if (!row) throw ApiError.notFound('User')
  return row
}

async function userByEmail(env: AppEnv['Bindings'], email: string) {
  const [row] = await getDb(env)
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1)
  return row ?? null
}

/* ------------------------------------------------------------------ *
 * Session
 *
 * These wrap Better Auth rather than reimplementing it. Every call goes through its HTTP handler,
 * which is where rate limiting, the `Origin` check and cookie signing live — see `auth/forward.ts`.
 * ------------------------------------------------------------------ */

app.post('/login', async (c) => {
  const { email, password } = await validate(c, loginSchema)

  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/sign-in/email', {
    email: email.toLowerCase(),
    password,
  })

  const user = await userByEmail(c.env, email)
  if (!user) throw ApiError.unauthorized('Incorrect email or password')

  applyCookies(c, cookies)
  return c.json({ data: toUser(user) })
})

app.post('/logout', async (c) => {
  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/sign-out')
  applyCookies(c, cookies)
  return c.json({ data: { ok: true } })
})

app.get('/me', async (c) => {
  const actor = requireUserActor(c)
  return c.json({ data: toUser(await userById(c.env, actor.id)) })
})

app.post('/change-password', async (c) => {
  requireUserActor(c)
  const input = await validate(
    c,
    z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }),
  )

  // Changing a password ends every *other* session: if the old one leaked, this is the moment the
  // person is telling us so.
  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/change-password', {
    ...input,
    revokeOtherSessions: true,
  })

  applyCookies(c, cookies)
  return c.json({ data: { ok: true } })
})

/* ------------------------------------------------------------------ *
 * Active sessions — so a user can see where they are signed in, and end any of it.
 * ------------------------------------------------------------------ */

app.get('/sessions', async (c) => {
  const actor = requireUserActor(c)
  const current = await getCmsAuth(c.env).api.getSession({ headers: c.req.raw.headers })

  const rows = await getDb(c.env)
    .select()
    .from(sessions)
    .where(eq(sessions.userId, actor.id))
    .orderBy(desc(sessions.createdAt))

  const data: UserSession[] = rows.map((row) => ({
    id: row.id,
    // The token itself is the credential, so it never leaves the server — revoking goes by id.
    current: row.token === current?.session.token,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }))

  return c.json({ data })
})

app.delete('/sessions/:id', async (c) => {
  const actor = requireUserActor(c)
  const db = getDb(c.env)

  const [row] = await db
    .delete(sessions)
    .where(and(eq(sessions.id, c.req.param('id')), eq(sessions.userId, actor.id)))
    .returning({ id: sessions.id })

  if (!row) throw ApiError.notFound('Session')
  return c.body(null, 204)
})

/** Signs the user out everywhere, including here. */
app.post('/sessions/revoke-all', async (c) => {
  requireUserActor(c)
  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/revoke-sessions')
  applyCookies(c, cookies)
  return c.json({ data: { ok: true } })
})

/* ------------------------------------------------------------------ *
 * First run
 * ------------------------------------------------------------------ */

/**
 * Bootstraps the very first owner account. Only works while the users table is empty, so it
 * is safe to leave enabled — after setup it returns 409 for everyone.
 *
 * The account row is written directly rather than through Better Auth's sign-up endpoint, because
 * that endpoint is disabled: a CMS with an open sign-up route is a CMS anyone can join.
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
      role: 'owner',
      // Whoever ran setup owns the deployment; there is nobody to verify them to.
      emailVerified: true,
    })
    .returning()

  await setPassword(c.env, user!.id, input.password)

  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/sign-in/email', {
    email: user!.email,
    password: input.password,
  })

  applyCookies(c, cookies)
  return c.json({ data: toUser(user!) }, 201)
})

app.get('/setup-required', async (c) => {
  const db = getDb(c.env)
  const [existing] = await db.select({ id: users.id }).from(users).limit(1)
  return c.json({ data: { setupRequired: !existing } })
})

/* ------------------------------------------------------------------ *
 * Invites
 * ------------------------------------------------------------------ */

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

  await setPassword(c.env, row.userId, input.password)
  await db
    .update(users)
    // Following a link sent to the address is what proves they hold it.
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.id, row.userId))
  await db
    .update(authTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(eq(authTokens.id, row.id))

  const user = await userById(c.env, row.userId)
  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/sign-in/email', {
    email: user.email,
    password: input.password,
  })

  applyCookies(c, cookies)
  return c.json({ data: toUser(user) })
})

/* ------------------------------------------------------------------ *
 * Password reset
 * ------------------------------------------------------------------ */

app.post('/forgot-password', async (c) => {
  const { email } = await validate(c, z.object({ email: z.email() }))

  // Better Auth answers identically whether or not the account exists, so this cannot enumerate
  // users — and it is rate limited, so it cannot be used to mail-bomb one either.
  await forwardToAuth(c, getCmsAuth(c.env), '/request-password-reset', {
    email: email.toLowerCase(),
    redirectTo: `${c.env.PUBLIC_URL}/reset-password`,
  })

  return c.json({ data: { ok: true } })
})

app.post('/reset-password', async (c) => {
  const input = await validate(c, z.object({ token: z.string().min(1), password: passwordSchema }))

  await forwardToAuth(c, getCmsAuth(c.env), '/reset-password', {
    token: input.token,
    newPassword: input.password,
  })

  return c.json({ data: { ok: true } })
})

/* ------------------------------------------------------------------ *
 * OAuth consent — the operator approving an MCP client that asked to act as them.
 * ------------------------------------------------------------------ */

/** What the consent screen needs to describe the request it is asking about. */
app.get('/oauth/pending', async (c) => {
  requireActor(c)
  const clientId = c.req.query('client_id')
  if (!clientId) throw ApiError.badRequest('client_id is required')

  const [client] = await getDb(c.env)
    .select({ name: oauthApplications.name, icon: oauthApplications.icon })
    .from(oauthApplications)
    .where(eq(oauthApplications.clientId, clientId))
    .limit(1)

  if (!client) throw ApiError.notFound('OAuth client')
  return c.json({ data: { clientId, name: client.name, icon: client.icon } })
})

/** MCP clients this user has approved, and still holds live tokens for. */
app.get('/oauth/clients', async (c) => {
  const actor = requireUserActor(c)

  const rows = await getDb(c.env)
    .selectDistinct({
      clientId: oauthAccessTokens.clientId,
      name: oauthApplications.name,
      icon: oauthApplications.icon,
      createdAt: oauthAccessTokens.createdAt,
    })
    .from(oauthAccessTokens)
    .innerJoin(oauthApplications, eq(oauthApplications.clientId, oauthAccessTokens.clientId))
    .where(eq(oauthAccessTokens.userId, actor.id))
    .orderBy(desc(oauthAccessTokens.createdAt))

  const data: AuthorizedClient[] = rows.map((row) => ({
    clientId: row.clientId,
    name: row.name,
    icon: row.icon,
    authorizedAt: row.createdAt.toISOString(),
  }))

  return c.json({ data })
})

/**
 * Ends a client's access: its tokens go, and so does the consent behind them — otherwise the next
 * authorization request would be approved silently on the strength of the old one.
 */
app.delete('/oauth/clients/:clientId', async (c) => {
  const actor = requireUserActor(c)
  const clientId = c.req.param('clientId')
  const db = getDb(c.env)

  await db
    .delete(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.userId, actor.id), eq(oauthAccessTokens.clientId, clientId)))
  await db
    .delete(oauthConsents)
    .where(and(eq(oauthConsents.userId, actor.id), eq(oauthConsents.clientId, clientId)))

  return c.body(null, 204)
})

export default app

/**
 * Writes a credential for a user, in the format Better Auth's configured hasher reads back.
 * Used by setup and invite acceptance, the two places a password is set without a session.
 */
async function setPassword(env: AppEnv['Bindings'], userId: string, password: string) {
  const db = getDb(env)
  const hash = await hashPassword(password)
  const now = new Date()

  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')))
    .limit(1)

  if (existing) {
    await db
      .update(accounts)
      .set({ password: hash, updatedAt: now })
      .where(eq(accounts.id, existing.id))
    return
  }

  await db.insert(accounts).values({
    id: newId('acc'),
    userId,
    accountId: userId,
    providerId: 'credential',
    password: hash,
    createdAt: now,
    updatedAt: now,
  })
}
