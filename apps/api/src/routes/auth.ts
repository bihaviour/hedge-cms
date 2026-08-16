import {
  type AuthorizedClient,
  acceptInviteSchema,
  inviteUserSchema,
  type LoginResult,
  loginSchema,
  passwordSchema,
  resendLoginCodeSchema,
  type User,
  type UserSession,
  verifyLoginCodeSchema,
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
  loginChallenges,
  oauthAccessTokens,
  oauthApplications,
  oauthConsents,
  sessions,
  users,
  verifications,
} from '../db/schema'
import type { AppEnv } from '../env'
import { requireActor, requirePermission, requireUserActor } from '../lib/auth'
import { hashPassword, hmac } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { hasCredential, sendUserInvite } from '../lib/invites'
import {
  completeLoginChallenge,
  isTrustedDevice,
  listTrustedDevices,
  pruneExpiredChallenges,
  resendLoginCode,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  startLoginChallenge,
} from '../lib/login-verification'
import { destructiveGrantsFor, setDestructiveGrant } from '../lib/mcp-grants'
import { permissionsForRole } from '../lib/roles'
import { requireSite } from '../lib/site'
import { throttle } from '../lib/throttle'
import { inviteUser } from '../lib/users'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

const toUser = (row: typeof users.$inferSelect, permissions: string[]): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  permissions,
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

  // A correct password on a browser this account has used before completes the sign-in, as it
  // always did. On one it has not, the password is not enough on its own — see `login-verification`.
  if (await isTrustedDevice(c, user.id)) {
    applyCookies(c, cookies)
    const data: LoginResult = {
      verificationRequired: false,
      user: toUser(user, await permissionsForRole(c.env, user.role)),
    }
    return c.json({ data })
  }

  // Best-effort housekeeping on the one path that grows this table; a failure here must not be the
  // reason somebody cannot sign in.
  await pruneExpiredChallenges(c.env).catch((error) =>
    console.error('[auth] pruning login challenges failed', error),
  )

  // Deliberately *not* `applyCookies`: the session exists but its cookies stay parked on the
  // challenge until the mailed code comes back.
  const challenge = await startLoginChallenge(c, user, cookies)
  const data: LoginResult = { verificationRequired: true, ...challenge }
  return c.json({ data })
})

/**
 * The second step: the code from the email, and whether to remember this browser for
 * `TRUSTED_DEVICE_TTL_DAYS`.
 *
 * Rate limited on top of the per-challenge attempt ceiling. The ceiling bounds guesses against one
 * code; this bounds how fast someone holding a password can spin up fresh challenges to guess at.
 */
app.post('/login/verify', async (c) => {
  const input = await validate(c, verifyLoginCodeSchema)
  await throttle(c, 'login-verify', { window: 15 * 60, max: 20 })

  const { userId, cookies } = await completeLoginChallenge(
    c,
    input.challengeId,
    input.code,
    input.trustDevice,
  )

  const user = await userById(c.env, userId)
  applyCookies(c, cookies)

  const data: LoginResult = {
    verificationRequired: false,
    user: toUser(user, await permissionsForRole(c.env, user.role)),
  }
  return c.json({ data })
})

/** Mails the code again — it went to spam, or the first one lapsed while they looked for it. */
app.post('/login/resend', async (c) => {
  const { challengeId } = await validate(c, resendLoginCodeSchema)
  // Tighter than the verify limiter: this one sends mail, so it is the mail-bomb surface.
  await throttle(c, 'login-resend', { window: 15 * 60, max: 5 })

  const db = getDb(c.env)
  const [row] = await db
    .select({ userId: loginChallenges.userId })
    .from(loginChallenges)
    .where(eq(loginChallenges.id, challengeId))
    .limit(1)

  if (!row) throw ApiError.unauthorized('That sign-in has expired. Start again.')

  const user = await userById(c.env, row.userId)
  return c.json({ data: await resendLoginCode(c, challengeId, user) })
})

app.post('/logout', async (c) => {
  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/sign-out')
  applyCookies(c, cookies)
  return c.json({ data: { ok: true } })
})

app.get('/me', async (c) => {
  const actor = requireUserActor(c)
  const row = await userById(c.env, actor.id)
  return c.json({ data: toUser(row, await permissionsForRole(c.env, row.role)) })
})

app.post('/change-password', async (c) => {
  const actor = requireUserActor(c)
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

  // …and every device vouched for under the old password, for the same reason. Ending the sessions
  // alone would leave an attacker's browser able to sign in with a password they later learn and
  // never be asked for a code, which is the one case this check exists for.
  await revokeAllTrustedDevices(c, actor.id)

  applyCookies(c, cookies)
  return c.json({ data: { ok: true } })
})

/* ------------------------------------------------------------------ *
 * Trusted devices — the browsers that skip the sign-in code, and the way to un-trust one.
 * ------------------------------------------------------------------ */

app.get('/devices', async (c) => {
  const actor = requireUserActor(c)
  return c.json({ data: await listTrustedDevices(c, actor.id) })
})

app.delete('/devices/:id', async (c) => {
  const actor = requireUserActor(c)
  await revokeTrustedDevice(c.env, actor.id, c.req.param('id'))
  return c.body(null, 204)
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

/**
 * Signs the user out everywhere, including here — and forgets every trusted browser with it.
 *
 * This is the panic button, so it has to leave nothing standing: a session revocation that kept
 * device trust would still let whoever holds the password back in without a code.
 */
app.post('/sessions/revoke-all', async (c) => {
  const actor = requireUserActor(c)
  const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/revoke-sessions')
  await revokeAllTrustedDevices(c, actor.id)
  applyCookies(c, cookies)
  return c.json({ data: { ok: true } })
})

/* ------------------------------------------------------------------ *
 * First run
 * ------------------------------------------------------------------ */

/**
 * Bootstraps the very first owner account — the first step of the onboarding wizard, which goes on
 * to create the first site. Only works while the users table is empty, so it is safe to leave
 * enabled: after setup it returns 409 for everyone.
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

  // The row above is what makes setup a one-time route, so anything that fails after it has to
  // take it away again. Otherwise a deployment lands in the one state it cannot leave: setup
  // answers 409 because a user exists, and that user has no password to sign in with.
  try {
    await setPassword(c.env, user!.id, input.password)

    const { cookies } = await forwardToAuth(c, getCmsAuth(c.env), '/sign-in/email', {
      email: user!.email,
      password: input.password,
    })

    applyCookies(c, cookies)
  } catch (error) {
    await db.delete(users).where(eq(users.id, user!.id))
    throw error
  }

  return c.json({ data: toUser(user!, await permissionsForRole(c.env, user!.role)) }, 201)
})

app.get('/setup-required', async (c) => {
  const db = getDb(c.env)
  const [existing] = await db.select({ id: users.id }).from(users).limit(1)
  return c.json({ data: { setupRequired: !existing } })
})

/* ------------------------------------------------------------------ *
 * Invites
 * ------------------------------------------------------------------ */

app.post('/invite', requirePermission('users:manage'), async (c) => {
  const input = await validate(c, inviteUserSchema)
  return c.json({ data: await inviteUser(c.env, input, requireSite(c).id) }, 201)
})

/** Sends the invite again — the first one bounced, went to spam, or simply expired. */
app.post('/invite/:id/resend', requirePermission('users:manage'), async (c) => {
  const user = await userById(c.env, c.req.param('id'))

  if (await hasCredential(c.env, user.id)) {
    throw ApiError.badRequest(
      `${user.name} has already set a password — they can reset it from the sign-in page`,
    )
  }

  await sendUserInvite(c.env, user)
  return c.json({ data: { ok: true } })
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
  return c.json({ data: toUser(user, await permissionsForRole(c.env, user.role)) })
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

  // Who the token belongs to has to be read *before* it is spent — the reset consumes the row.
  // Best-effort by design: it reaches into how Better Auth stores a reset token, so if that ever
  // changes the worst outcome is a device that stays trusted, not a reset that fails.
  const userId = await userIdForResetToken(c.env, input.token)

  await forwardToAuth(c, getCmsAuth(c.env), '/reset-password', {
    token: input.token,
    newPassword: input.password,
  })

  // A reset is how somebody who lost control recovers, which is exactly when a browser vouched for
  // under the old password should stop being vouched for. `revokeSessionsOnPasswordReset` already
  // ends the sessions; this ends the trust that would let a new sign-in skip the code.
  if (userId) {
    await revokeAllTrustedDevices(c, userId).catch((error) =>
      console.error('[auth] clearing trusted devices after reset failed', error),
    )
  }

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

/**
 * Approving an MCP client, with whatever the operator narrowed (#145).
 *
 * This exists because Better Auth's own `/oauth2/consent` cannot express a narrowing: it takes
 * `{accept, consent_code}`, and the scope it grants was parked server-side when the authorization
 * request arrived. So the decision is recorded beside it, in our own table, and applied where the
 * tools are built.
 *
 * **The order is the safety argument, and it is enforced here rather than trusted to the browser.**
 * The grant is written first and the consent given second, so a failure to record means no token is
 * ever issued. The other way round leaves a window holding a live token with no narrowing behind
 * it — and since an unrecorded grant means *granted*, that window defaults to the widest answer.
 */
app.post('/oauth/consent', async (c) => {
  const actor = requireUserActor(c)
  const input = await validate(
    c,
    z.object({
      consentCode: z.string().min(1),
      clientId: z.string().min(1),
      accept: z.boolean(),
      /** False only when the operator cleared the box. Absent means they left it as it was. */
      destructive: z.boolean().default(true),
    }),
  )

  if (input.accept) {
    await setDestructiveGrant(c.env, actor.id, input.clientId, input.destructive)
  }

  const result = await getCmsAuth(c.env)
    .api.oAuthConsent({
      body: { accept: input.accept, consent_code: input.consentCode },
      headers: c.req.raw.headers,
    })
    .catch(() => null)

  if (!result?.redirectURI) {
    throw ApiError.badRequest('Could not complete the authorization request')
  }

  return c.json({ data: { redirectURI: result.redirectURI } })
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

  // What each was narrowed to. One query for the lot rather than one per client, and an unrecorded
  // grant reads as `true` here for the same reason it does at the endpoint.
  const grants = await destructiveGrantsFor(c.env, actor.id)

  const data: AuthorizedClient[] = rows.map((row) => ({
    clientId: row.clientId,
    name: row.name,
    icon: row.icon,
    authorizedAt: row.createdAt.toISOString(),
    destructive: grants.get(row.clientId) ?? true,
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
 * The user a password-reset token belongs to, or null.
 *
 * Better Auth parks a reset under `verifications` with the token in the identifier and the user id
 * as the value. That is its internal shape rather than a documented contract, so every failure here
 * — no row, a changed convention, a database error — answers null and the caller carries on. The
 * only thing that depends on it is clearing trusted devices, which is hygiene on top of the session
 * revocation Better Auth already performs.
 */
async function userIdForResetToken(env: AppEnv['Bindings'], token: string): Promise<string | null> {
  try {
    const [row] = await getDb(env)
      .select({ value: verifications.value })
      .from(verifications)
      .where(eq(verifications.identifier, `reset-password:${token}`))
      .limit(1)
    return row?.value ?? null
  } catch (error) {
    console.error('[auth] reset token lookup failed', error)
    return null
  }
}

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
