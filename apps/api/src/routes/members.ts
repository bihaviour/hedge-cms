import {
  createMemberSchema,
  MEMBER_TOKEN_EXPIRY_FRAGMENT_KEY,
  MEMBER_TOKEN_FRAGMENT_KEY,
  type Member,
  memberLoginSchema,
  memberMagicLinkSchema,
  memberRegisterSchema,
  mintMemberSessionSchema,
  passwordSchema,
  updateMemberSchema,
} from '@hedge/core'
import { and, count, desc, eq, like, lt, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { authApiError } from '../auth/errors'
import {
  getMemberAuth,
  hasCredential,
  mintMemberSession,
  revokeMemberSession,
} from '../auth/member'
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
import { requireActor, requireScope, requireSiteRole } from '../lib/auth'
import { hashPassword } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { memberGrant, requireMember } from '../lib/member-auth'
import { requireSite } from '../lib/site'
import { clientIp, throttle } from '../lib/throttle'
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

/**
 * The same member, as the admin sees them. `pending` is the absence of a password: an invited
 * member exists from the moment they are added, but cannot sign in until they follow their link.
 */
function toAdminMember(
  row: MemberRow,
  grant: Pick<MemberSiteRow, 'siteId' | 'status' | 'lastLoginAt'>,
  pending: boolean,
): Member & { pending: boolean } {
  return { ...toMember(row, grant), pending }
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

/**
 * Sets the password behind a reset link — which is also the invite link an admin-added member gets.
 *
 * The token is the only thing that can fail here: `passwordSchema` is the same 12–200 as the member
 * instance's own `minPasswordLength`/`maxPasswordLength`, so `validate` has already refused every
 * length Better Auth would, and a `400` reaching us is a token that expired, was already spent, or
 * was never issued. Hence the one message for it — see `authApiError` for why a website needs that
 * told apart from a 500.
 */
memberAuth.post('/reset-password', async (c) => {
  const input = await validate(c, z.object({ token: z.string().min(1), password: passwordSchema }))

  await getMemberAuth(c.env)
    .api.resetPassword({ body: { token: input.token, newPassword: input.password } })
    .catch((error) => {
      throw authApiError(error, '/reset-password', 'That reset link is invalid or has expired')
    })

  return c.json({ data: { ok: true } })
})

/**
 * The link in a verification email. It marks the address confirmed and then hands the reader back
 * to the website they came from, so the last thing they see is the site, not the CMS.
 *
 * A dead link answers `401 unauthorized`, which is the status Better Auth picked for it, rather than
 * the `500` it used to (#131). This one is a page a reader lands on rather than a `fetch` a website
 * makes, so getting it wrong is a browser showing "Something went wrong" over what is really an
 * expired link.
 */
memberAuth.get('/verify-email', async (c) => {
  const token = c.req.query('token')
  if (!token) throw ApiError.badRequest('token is required')

  await getMemberAuth(c.env)
    .api.verifyEmail({ query: { token } })
    .catch((error) => {
      throw authApiError(error, '/verify-email', 'That verification link is invalid or has expired')
    })

  const site = c.get('site')
  return site?.domain ? c.redirect(`https://${site.domain}/`) : c.json({ data: { ok: true } })
})

/**
 * Emails a sign-in link, for a reader with no Hedge password or no wish to type one.
 *
 * Answers `{ ok: true }` whichever way it goes — an address that is not a member of anything gets
 * no mail and no different answer, so this cannot be used to ask who reads a site.
 */
memberAuth.post('/magic-link', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, memberMagicLinkSchema)
  const email = input.email.toLowerCase()

  await throttle(c, `member-magic-link:${site.id}`, { window: 900, max: 10 })
  // And again per recipient, keyed on the address instead of the caller: the limit above is one an
  // attacker resets by moving, and the thing being protected is somebody's inbox.
  await throttle(c, `member-magic-link-to:${site.id}`, { window: 900, max: 3 }, email)

  const member = await memberByEmail(c.env, email)
  if (member) {
    await getMemberAuth(c.env).api.signInMagicLink({
      body: {
        email,
        callbackURL: siteLanding(site, input.callbackURL) ?? undefined,
        // The greeting. `sendMagicLink` is handed an address and nothing else, and the member is
        // already loaded here.
        metadata: { name: member.name },
      },
      headers: c.req.raw.headers,
    })
  }

  return c.json({ data: { ok: true } })
})

/**
 * The link itself. Redeems the token, applies this site's grant rules, and hands the reader back to
 * the website with a member token.
 *
 * The token travels in the URL **fragment**, which is never sent to a server: it stays out of the
 * website's logs, out of `Referer`, and out of every proxy between the two. A website reads it from
 * `location.hash`, stores it, and clears the hash. With no domain configured there is nowhere to
 * send anyone, so the session comes back as JSON in the shape `/member/login` answers with.
 */
memberAuth.get('/magic-link/verify', async (c) => {
  const site = requireSite(c)
  const token = c.req.query('token')
  if (!token) throw ApiError.badRequest('token is required')

  await throttle(c, `member-magic-verify:${site.id}`, { window: 900, max: 30 })

  const verified = await getMemberAuth(c.env)
    .api.magicLinkVerify({ query: { token }, headers: c.req.raw.headers })
    .catch(() => null)

  // One message for expired, already-used and never-existed alike. Telling them apart would confirm
  // which addresses have been mailed a link.
  if (!verified?.token) throw ApiError.unauthorized('That sign-in link is invalid or has expired')

  const [member] = await getDb(c.env)
    .select()
    .from(members)
    .where(eq(members.id, verified.user.id))
    .limit(1)
  if (!member) throw ApiError.unauthorized('That sign-in link is invalid or has expired')

  // Redeeming the link proved an address; it did not decide whether this site takes that reader.
  // A session already exists by now, so a refusal has to take it with it — a live token nobody was
  // handed is still a live token.
  const grant = await grantForSignIn(c.env, site, member.id).catch(async (error) => {
    await revokeMemberSession(c.env, verified.token)
    throw error
  })

  const expiresAt = await sessionExpiry(c.env, verified.token)
  const landing = siteLanding(site, c.req.query('redirect'))

  if (!landing)
    return c.json({ data: { token: verified.token, expiresAt, member: toMember(member, grant) } })

  const url = new URL(landing)
  url.hash = new URLSearchParams({
    [MEMBER_TOKEN_FRAGMENT_KEY]: verified.token,
    [MEMBER_TOKEN_EXPIRY_FRAGMENT_KEY]: expiresAt,
  }).toString()

  return c.redirect(url.toString())
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

  // The cursor narrows the page, not the count — see `listEntries` for why they are kept apart.
  const pageFilters = query.cursor ? [...filters, lt(members.id, query.cursor)] : filters

  const db = getDb(c.env)
  const [rows, [counted]] = await Promise.all([
    db
      .select({ member: members, grant: memberSites, credential: memberAccounts.id })
      .from(memberSites)
      .innerJoin(members, eq(members.id, memberSites.memberId))
      .leftJoin(
        memberAccounts,
        and(eq(memberAccounts.userId, members.id), eq(memberAccounts.providerId, 'credential')),
      )
      .where(and(...pageFilters))
      .orderBy(desc(members.id))
      .limit(query.limit + 1),
    // The credential join is deliberately left out of the count: it decides `pending`, not whether
    // a member is on this site, and a left join is the wrong thing to be counting rows through.
    db
      .select({ value: count() })
      .from(memberSites)
      .innerJoin(members, eq(members.id, memberSites.memberId))
      .where(and(...filters)),
  ])

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows

  return c.json({
    data: page.map((row) => toAdminMember(row.member, row.grant, row.credential === null)),
    nextCursor: hasMore ? (page.at(-1)?.member.id ?? null) : null,
    total: counted?.value ?? 0,
  })
})

/**
 * Adds a member to this site and emails them a link to choose a password.
 *
 * An admin never sets that password: the only person who should ever know a member's credential is
 * the member, and an emailed link is also what proves the address is theirs.
 */
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

  const [grant] = await db
    .insert(memberSites)
    .values({ siteId: site.id, memberId: member.id })
    .returning()

  // Someone who already reads another site in this deployment has a password and an inbox full of
  // nothing to do about it, so only a genuinely new account is invited.
  const pending = !(await hasCredential(c.env, member.id))
  if (pending) await sendInvite(c.env, site, email)

  return c.json({ data: toAdminMember(member, grant!, pending) }, 201)
})

/** Sends the invite again — the first one bounced, went to spam, or simply expired. */
app.post('/:id/invite', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const id = c.req.param('id')

  const grant = await memberGrant(c.env, id, site.id)
  if (!grant) throw ApiError.notFound('Member')

  const [member] = await getDb(c.env).select().from(members).where(eq(members.id, id)).limit(1)
  if (!member) throw ApiError.notFound('Member')

  if (await hasCredential(c.env, member.id)) {
    throw ApiError.badRequest(
      `${member.name} has already set a password — they can reset it themselves from the site`,
    )
  }

  await sendInvite(c.env, site, member.email)
  return c.json({ data: { ok: true } })
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

/* ------------------------------------------------------------------ *
 * Minting a session server to server, mounted at /api/v1/member-sessions (#108).
 *
 * Its own prefix rather than `POST /members/:id/session`, because the prefix is what decides which
 * credential is resolved at all: `/api/v1/members` is session-only on purpose — a machine has no
 * business reading a site's member list — and this is the one member route a machine *is* meant to
 * reach. `/api/v1/newsletter` beside `/api/v1/newsletters` is the same split for the same reason.
 * ------------------------------------------------------------------ */

export const memberSessionMint = new Hono<AppEnv>()

/**
 * Signs a reader in on the word of a caller that has already authenticated them — the site's own
 * application, a customer portal, anything first-party that knows who they are. It answers exactly
 * what `POST /member/login` answers, so a website's existing handling of a token is unchanged.
 *
 * **A session is not a password.** Nothing here reads, sets or needs the member's credential, so
 * the rule that an admin never chooses somebody's password is untouched — this is the SSO handoff
 * that rule made impossible, not a way around it.
 *
 * Two gates, both of which have to hold:
 *
 * - `requireSiteRole('admin')`, which for a key means the scope below (`roleForScopes`), and for a
 *   person means a site admin. Handing out a reader's session is not editorial work.
 * - `requireScope('members:session')`, so an authoring key that reaches this prefix for content and
 *   media cannot mint one by virtue of living next door. The prefix decides what is *resolved*; the
 *   route decides what is *allowed*.
 *
 * **A `pending` member is minted for, deliberately.** They have never set a password — but a
 * password is precisely what this flow exists to avoid, and the caller has already authenticated
 * the person by other means. Refusing would make just-in-time provisioning impossible: add the
 * member, sign them in, never mail them anything. It is the surprising choice of the two, which is
 * why it is written down rather than left to be inferred from the absence of a check.
 */
memberSessionMint.post(
  '/',
  requireSiteRole('admin'),
  requireScope('members:session'),
  async (c) => {
    const site = requireSite(c)
    const actor = requireActor(c)
    const input = await validate(c, mintMemberSessionSchema)

    await throttle(c, `member-mint:${site.id}`, { window: 60, max: 60 })

    const [member] = await getDb(c.env)
      .select()
      .from(members)
      .where(eq(members.id, input.memberId))
      .limit(1)
    if (!member) throw ApiError.notFound('Member')

    // The same grant rules a password sign-in goes through: blocked is refused, an invite-only site
    // is refused, an open one is joined, and `lastLoginAt` moves — because this *is* a sign-in.
    const grant = await grantForSignIn(c.env, site, member.id)

    const session = await mintMemberSession(c.env, member.id, {
      ipAddress: clientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    })

    /**
     * The one route in Hedge that issues a credential to somebody other than its owner, so it says so
     * where an operator can find it afterwards: which key or user minted what, for whom.
     *
     * The token itself is never logged. Naming the session's id would be enough to correlate a log
     * line with a row without writing a live credential into a log sink.
     */
    console.info(
      '[member-session] minted',
      JSON.stringify({
        requestId: c.get('requestId'),
        siteId: site.id,
        memberId: member.id,
        by: { kind: actor.kind, via: actor.via, id: actor.id },
        ip: clientIp(c),
        expiresAt: session.expiresAt,
      }),
    )

    return c.json({ data: { ...session, member: toMember(member, grant) } }, 201)
  },
)

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
 * Emails a member the link that lets them choose their first password.
 *
 * It is Better Auth's own reset flow — the token, its expiry and its single use are all handled
 * there, and it picks the invitation wording precisely because there is no password yet.
 */
async function sendInvite(env: Bindings, site: SiteRow, email: string): Promise<void> {
  await getMemberAuth(env).api.requestPasswordReset({
    body: { email, redirectTo: resetRedirect(env, site) },
  })
}

/**
 * Only ever a URL on the site's own domain — a reset link is emailed on nothing but an address, so
 * an unchecked `redirectTo` would turn this into an open redirect anyone could aim anywhere.
 *
 * With no domain configured there is no website to land on, so the link comes back to the admin's
 * own reset page. `audience=member` is what tells that page to set a *member's* password: the token
 * belongs to the member instance, and the CMS instance could not read it.
 */
function resetRedirect(env: Bindings, site: SiteRow, requested?: string): string {
  const fallback = site.domain
    ? `https://${site.domain}/reset-password`
    : `${env.PUBLIC_URL}/reset-password?audience=member`

  if (!requested) return fallback
  if (!site.domain) return fallback

  try {
    return new URL(requested).host === site.domain ? requested : fallback
  } catch {
    return fallback
  }
}

/**
 * A page on the site's own domain to send a reader to, or `null` when the site has no domain and
 * therefore no website to land on.
 *
 * The same open-redirect argument as `resetRedirect`: a sign-in link is emailed on nothing but an
 * address, so a `callbackURL` nobody checked would let anyone aim one anywhere. It is validated
 * when the link is minted *and* again when it is redeemed, because the two are separated by a round
 * trip through an inbox and only the second one is the redirect that actually happens.
 */
function siteLanding(site: SiteRow, requested?: string | null): string | null {
  if (!site.domain) return null
  const fallback = `https://${site.domain}/`
  if (!requested) return fallback

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
