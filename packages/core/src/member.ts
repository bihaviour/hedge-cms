import { z } from 'zod'
import { passwordSchema } from './auth'

/**
 * Members are the audience of a site, not operators of the CMS. They live in their own table,
 * belong to exactly one site, and authenticate with a bearer token rather than the admin session
 * cookie — so no credential a member holds can ever resolve to a CMS user.
 */

/** Header a website sends to prove a request is coming from a signed-in member. */
export const MEMBER_TOKEN_HEADER = 'x-member-token'

export const MEMBER_STATUSES = ['active', 'blocked'] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]

export const memberSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  email: z.email(),
  name: z.string(),
  status: z.enum(MEMBER_STATUSES),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
})

export type Member = z.infer<typeof memberSchema>

export const memberRegisterSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  password: passwordSchema,
})

export type MemberRegisterInput = z.infer<typeof memberRegisterSchema>

export const memberLoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

export type MemberLoginInput = z.infer<typeof memberLoginSchema>

/** What a member gets back from register and login — the token is theirs to store. */
export const memberSessionSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  member: memberSchema,
})

export type MemberSession = z.infer<typeof memberSessionSchema>

/**
 * Admin-side creation. There is no password field on purpose: a member's password is theirs to
 * choose, so adding one here emails them a link instead. Nobody hands out a credential they know.
 *
 * Strict, so a caller still sending `password` is told it is refused rather than watching it be
 * silently dropped and wondering later why the account it thought it made cannot sign in.
 */
export const createMemberSchema = z.strictObject({
  email: z.email(),
  name: z.string().min(1).max(120),
})

export type CreateMemberInput = z.infer<typeof createMemberSchema>

export const updateMemberSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
})

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>

/* ------------------------------------------------------------------ *
 * Signing a reader in without a Hedge password (#108)
 *
 * Two ways, for two arrivals. A reader who comes *from* an application that already knows who they
 * are is signed in by that application, server to server. A reader who lands on a gated page from a
 * search result has no such handoff, and gets a link in their inbox instead.
 * ------------------------------------------------------------------ */

/**
 * What a trusted server posts to mint a session for one of its readers.
 *
 * There is no `expiresIn`, and its absence is deliberate rather than pending: a member session is
 * refreshed on use (`updateAge`), and that refresh resets the expiry to the instance-wide session
 * lifetime — so a session minted with a shorter one would quietly become a 30-day session the first
 * time it was used. A TTL the runtime does not keep is worse than the honest default.
 *
 * Strict, so a caller sending `expiresIn` or a password is told it was refused rather than watching
 * it be dropped and believing in a shorter session than it got.
 */
export const mintMemberSessionSchema = z.strictObject({ memberId: z.string().min(1) })

export type MintMemberSessionInput = z.infer<typeof mintMemberSessionSchema>

/** How long a magic link stays redeemable. Short: it is a live credential sitting in an inbox. */
export const MEMBER_MAGIC_LINK_TTL_MINUTES = 15

/**
 * Asking for a sign-in link. `callbackURL` is where the reader lands afterwards and is checked
 * against the site's own domain, the same way `redirectTo` on a password reset is — a link mailed
 * on nothing but an address would otherwise be an open redirect anyone could aim anywhere.
 */
export const memberMagicLinkSchema = z.object({
  email: z.email(),
  callbackURL: z.url().optional(),
})

export type MemberMagicLinkInput = z.infer<typeof memberMagicLinkSchema>

/**
 * The fragment the verify route hands the token back in, e.g.
 * `https://example.com/welcome#hedge_member_token=…&hedge_member_expires=…`.
 *
 * A fragment rather than a query string because a fragment is never sent to a server: it stays out
 * of the website's access logs, out of `Referer` on the next navigation, and out of any proxy in
 * between. The page reads it, stores the token, and clears the hash.
 */
export const MEMBER_TOKEN_FRAGMENT_KEY = 'hedge_member_token'
export const MEMBER_TOKEN_EXPIRY_FRAGMENT_KEY = 'hedge_member_expires'
