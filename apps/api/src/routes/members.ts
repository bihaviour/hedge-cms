import {
  createMemberSchema,
  type Member,
  memberLoginSchema,
  memberRegisterSchema,
  passwordSchema,
  updateMemberSchema,
} from '@hedge/core'
import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getMemberAuth } from '../auth/member'
import { getDb } from '../db/client'
import {
  type MemberRow,
  type MemberSiteRow,
  memberAccounts,
  memberSessions,
  memberSites,
  members,
  type SiteRow,
} from '../db/schema'
import type { AppEnv, Bindings } from '../env'
import { requireSiteRole } from '../lib/auth'
import { hashPassword } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { memberGrant, requireMember } from '../lib/member-auth'
import { requireSite } from '../lib/site'
import { throttle } from '../lib/throttle'
import { validate, validateQuery } from '../lib/validate'

/**
 * The wire shape a website already expects: one member *of one site*. Underneath, the identity and
 * the site grant are separate rows — `siteId` and `status` come from the grant.
 */
function toMember(row: MemberRow, grant: Pick<MemberSiteRow, 'siteId' | 'status' | 'lastLoginAt'>) {
  return {
    id: row.id,
    siteId: grant.siteId,
    email: row.email,
    name: row.name,
    status: grant.status,
    lastLoginAt: grant.lastLoginAt,
    createdAt: row.createdAt.toISOString(),
  } satisfies Member
}

async function memberByEmail(env: Bindings, email: string): Promise<MemberRow | null> {
  const [row] = await getDb(env)
    .select()
    .from(members)
    .where(eq(members.email, email.toLowerCase()))
    .limit(1)
  return row ?? null
}

/** The expiry Better Auth stored for a freshly issued token, so the website can plan around it. */
async function sessionExpiry(env: Bindings, token: string): Promise<string> {
  const [row] = await getDb(env)
    .select({ expiresAt: memberSessions.expiresAt })
    .from(memberSessions)
    .where(eq(memberSessions.token, token))
    .limit(1)
  return (row?.expiresAt ?? new Date()).toISOString()
}

/**
 * Records the sign-in and makes sure the member belongs to this site.
 *
 * A member identity spans the deployment, so signing in to a second site is a *join*: allowed when
 * that site takes signups, refused when it is invite-only. Blocking is per site, so a reader barred
 * from the blog can still read the docs.
 */
async function grantForSignIn(
  env: Bindings,
  site: SiteRow,
  memberId: string,
): Promise<MemberSiteRow> {
  const existing = await memberGrant(env, memberId, site.id)
  const db = getDb(env)
  const now = new Date().toISOString()

  if (existing) {
    if (existing.status === 'blocked') throw ApiError.forbidden('This account has been blocked')
    await db
      .update(memberSites)
      .set({ lastLoginAt: now })
      .where(and(eq(memberSites.siteId, site.id), eq(memberSites.memberId, memberId)))
    return { ...existing, lastLoginAt: now }
  }

  if (!site.allowMemberSignup) {
    throw ApiError.forbidden('This site is invite-only — ask an editor to add you')
  }

  const [grant] = await db
    .insert(memberSites)
    .values({ siteId: site.id, memberId, lastLoginAt: now })
    .returning()

  return grant!
}

/* ------------------------------------------------------------------ *
 * Public member auth, mounted at /api/v1/member.
 *
 * The only routes a website visitor ever touches. Site-scoped, no session cookie, and the token
 * they get back is theirs to store and replay in `X-Member-Token`.
 *
 * These call Better Auth's server API rather than its HTTP handler: the caller is a website on its
 * own origin, so the handler's `Origin` check cannot apply. What it would have given us for free —
 * a limit on how fast passwords can be guessed — is applied explicitly with `throttle`.
 * ------------------------------------------------------------------ */

export const memberAuth = new Hono<AppEnv>()

memberAuth.post('/register', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, memberRegisterSchema)
  await throttle(c, `member-register:${site.id}`, { window: 3600, max: 10 })

  if (!site.allowMemberSignup) {
    throw ApiError.forbidden('This site is invite-only — ask an editor to add you')
  }

  const email = input.email.toLowerCase()
  const existing = await memberByEmail(c.env, email)
  const db = getDb(c.env)

  // An admin can add a member ahead of time, or the reader may already have an account on another
  // site in this deployment. Either way, claiming it means proving the password — which is a
  // sign-in, not a registration.
  if (existing) {
    const [credential] = await db
      .select({ id: memberAccounts.id })
      .from(memberAccounts)
      .where(
        and(eq(memberAccounts.userId, existing.id), eq(memberAccounts.providerId, 'credential')),
      )
      .limit(1)

    if (credential) throw ApiError.conflict('An account with that email already exists')

    await setMemberPassword(c.env, existing.id, input.password)
    await db
      .update(members)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(members.id, existing.id))

    const signedIn = await signIn(c, email, input.password)
    const grant = await grantForSignIn(c.env, site, existing.id)
    return c.json({ data: { ...signedIn, member: toMember(signedIn.member, grant) } }, 201)
  }

  const result = await getMemberAuth(c.env).api.signUpEmail({
    body: { email, name: input.name, password: input.password },
  })

  const grant = await grantForSignIn(c.env, site, result.user.id)
  const row = (await memberByEmail(c.env, email))!

  return c.json(
    {
      data: {
        token: result.token ?? '',
        expiresAt: await sessionExpiry(c.env, result.token ?? ''),
        member: toMember(row, grant),
      },
    },
    201,
  )
})

memberAuth.post('/login', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, memberLoginSchema)
  await throttle(c, `member-login:${site.id}`, { window: 300, max: 10 })

  const signedIn = await signIn(c, input.email.toLowerCase(), input.password)
  const grant = await grantForSignIn(c.env, site, signedIn.member.id)

  return c.json({ data: { ...signedIn, member: toMember(signedIn.member, grant) } })
})

memberAuth.post('/logout', async (c) => {
  const token = c.req.header('x-member-token')?.trim()
  if (token) {
    await getMemberAuth(c.env).api.signOut({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    })
  }
  return c.json({ data: { ok: true } })
})

memberAuth.get('/me', async (c) => {
  const site = requireSite(c)
  const member = requireMember(c)
  const grant = (await memberGrant(c.env, member.id, site.id))!
  return c.json({ data: toMember(member, grant) })
})

memberAuth.post('/forgot-password', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, z.object({ email: z.email(), redirectTo: z.url().optional() }))
  await throttle(c, `member-forgot:${site.id}`, { window: 900, max: 5 })

  // Answers the same either way, so it cannot be used to test which addresses are members.
  await getMemberAuth(c.env).api.requestPasswordReset({
    body: {
      email: input.email.toLowerCase(),
      redirectTo: resetRedirect(c.env, site, input.redirectTo),
    },
  })

  return c.json({ data: { ok: true } })
})

memberAuth.post('/reset-password', async (c) => {
  const input = await validate(c, z.object({ token: z.string().min(1), password: passwordSchema }))

  await getMemberAuth(c.env).api.resetPassword({
    body: { token: input.token, newPassword: input.password },
  })

  return c.json({ data: { ok: true } })
})

/**
 * The link in a verification email. It marks the address confirmed and then hands the reader back
 * to the website they came from, so the last thing they see is the site, not the CMS.
 */
memberAuth.get('/verify-email', async (c) => {
  const token = c.req.query('token')
  if (!token) throw ApiError.badRequest('token is required')

  await getMemberAuth(c.env).api.verifyEmail({ query: { token } })

  const site = c.get('site')
  return site?.domain ? c.redirect(`https://${site.domain}/`) : c.json({ data: { ok: true } })
})

memberAuth.post('/send-verification-email', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, z.object({ email: z.email() }))
  await throttle(c, `member-verify:${site.id}`, { window: 900, max: 5 })

  await getMemberAuth(c.env).api.sendVerificationEmail({
    body: { email: input.email.toLowerCase() },
  })
  return c.json({ data: { ok: true } })
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

  const filters: SQL[] = [eq(memberSites.siteId, site.id)]
  if (query.q) filters.push(like(members.email, `%${query.q.toLowerCase()}%`))
  if (query.cursor) filters.push(lt(members.id, query.cursor))

  const rows = await getDb(c.env)
    .select({ member: members, grant: memberSites })
    .from(memberSites)
    .innerJoin(members, eq(members.id, memberSites.memberId))
    .where(and(...filters))
    .orderBy(desc(members.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows

  return c.json({
    data: page.map((row) => toMember(row.member, row.grant)),
    nextCursor: hasMore ? (page.at(-1)?.member.id ?? null) : null,
  })
})

app.post('/', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, createMemberSchema)
  const db = getDb(c.env)
  const email = input.email.toLowerCase()

  // The identity may already exist from another site in this deployment; adding them here is a
  // grant, not a second account.
  let member = await memberByEmail(c.env, email)
  if (member) {
    const existingGrant = await memberGrant(c.env, member.id, site.id)
    if (existingGrant) throw ApiError.conflict('That email is already a member of this site')
  } else {
    const [row] = await db
      .insert(members)
      .values({ id: newId('mem'), email, name: input.name })
      .returning()
    member = row!
  }

  // Left unset when no password is given: the member sets one by registering with this email.
  if (input.password) await setMemberPassword(c.env, member.id, input.password)

  const [grant] = await db
    .insert(memberSites)
    .values({ siteId: site.id, memberId: member.id })
    .returning()

  return c.json({ data: toMember(member, grant!) }, 201)
})

app.patch('/:id', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, updateMemberSchema)
  const db = getDb(c.env)
  const id = c.req.param('id')

  const grant = await memberGrant(c.env, id, site.id)
  if (!grant) throw ApiError.notFound('Member')

  if (input.status !== undefined) {
    await db
      .update(memberSites)
      .set({ status: input.status })
      .where(and(eq(memberSites.siteId, site.id), eq(memberSites.memberId, id)))
  }

  const [row] = input.name
    ? await db
        .update(members)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(members.id, id))
        .returning()
    : await db.select().from(members).where(eq(members.id, id)).limit(1)

  if (!row) throw ApiError.notFound('Member')
  return c.json({ data: toMember(row, { ...grant, status: input.status ?? grant.status }) })
})

/**
 * Removes a member from *this* site. The identity itself only goes when nothing is left to belong
 * to — otherwise deleting a reader from the blog would sign them out of the docs site too.
 */
app.delete('/:id', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const db = getDb(c.env)
  const id = c.req.param('id')

  const [removed] = await db
    .delete(memberSites)
    .where(and(eq(memberSites.memberId, id), eq(memberSites.siteId, site.id)))
    .returning({ memberId: memberSites.memberId })

  if (!removed) throw ApiError.notFound('Member')

  const remaining = await db
    .select({ siteId: memberSites.siteId })
    .from(memberSites)
    .where(eq(memberSites.memberId, id))
    .limit(1)

  // Sessions and credentials cascade with the identity, so this signs them out everywhere.
  if (remaining.length === 0) await db.delete(members).where(eq(members.id, id))

  return c.body(null, 204)
})

export default app

/** Signs a member in and normalises what Better Auth hands back into our wire shape. */
async function signIn(c: { env: Bindings }, email: string, password: string) {
  const result = await getMemberAuth(c.env)
    .api.signInEmail({ body: { email, password } })
    .catch(() => null)

  if (!result?.token) throw ApiError.unauthorized('Incorrect email or password')

  const member = await memberByEmail(c.env, email)
  if (!member) throw ApiError.unauthorized('Incorrect email or password')

  return {
    token: result.token,
    expiresAt: await sessionExpiry(c.env, result.token),
    member,
  }
}

/**
 * Only ever a URL on the site's own domain — a reset link is emailed on nothing but an address, so
 * an unchecked `redirectTo` would turn this into an open redirect anyone could aim anywhere.
 */
function resetRedirect(env: Bindings, site: SiteRow, requested?: string): string {
  const fallback = site.domain
    ? `https://${site.domain}/reset-password`
    : `${env.PUBLIC_URL}/reset-password`

  if (!requested) return fallback
  if (!site.domain) return fallback

  try {
    return new URL(requested).host === site.domain ? requested : fallback
  } catch {
    return fallback
  }
}

async function setMemberPassword(env: Bindings, memberId: string, password: string) {
  const db = getDb(env)
  const hash = await hashPassword(password)
  const now = new Date()

  const [existing] = await db
    .select({ id: memberAccounts.id })
    .from(memberAccounts)
    .where(and(eq(memberAccounts.userId, memberId), eq(memberAccounts.providerId, 'credential')))
    .limit(1)

  if (existing) {
    await db
      .update(memberAccounts)
      .set({ password: hash, updatedAt: now })
      .where(eq(memberAccounts.id, existing.id))
    return
  }

  await db.insert(memberAccounts).values({
    id: newId('mac'),
    userId: memberId,
    accountId: memberId,
    providerId: 'credential',
    password: hash,
    createdAt: now,
    updatedAt: now,
  })
}
