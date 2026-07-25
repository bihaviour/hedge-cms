import { MEMBER_TOKEN_HEADER } from '@hedge/core'
import { and, eq, gt } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getDb } from '../db/client'
import { type MemberRow, memberSessions, members } from '../db/schema'
import type { AppEnv } from '../env'
import { hmac, randomToken } from './crypto'
import { ApiError } from './errors'

export const MEMBER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
export const MEMBER_TOKEN_PREFIX = 'hdm_'

/**
 * Member sessions are bearer tokens, not cookies: a member signs in from the website Hedge
 * feeds, which is a different origin, and the token is what that site stores and replays.
 *
 * Nothing here can ever produce an `Actor` — the admin API resolves its caller from `users` and
 * `api_keys` alone, so a member token is inert against every route under `/api/v1` that is not
 * member auth or delivery.
 */
export async function createMemberSession(
  c: Context<AppEnv>,
  memberId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = `${MEMBER_TOKEN_PREFIX}${randomToken(32)}`
  const expiresAt = Math.floor(Date.now() / 1000) + MEMBER_SESSION_TTL_SECONDS

  await getDb(c.env)
    .insert(memberSessions)
    .values({ id: await hmac(c.env.AUTH_SECRET, token), memberId, expiresAt })

  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() }
}

export async function destroyMemberSession(c: Context<AppEnv>): Promise<void> {
  const token = memberToken(c)
  if (!token) return
  await getDb(c.env)
    .delete(memberSessions)
    .where(eq(memberSessions.id, await hmac(c.env.AUTH_SECRET, token)))
}

function memberToken(c: Context<AppEnv>): string | null {
  const header = c.req.header(MEMBER_TOKEN_HEADER)?.trim()
  return header?.startsWith(MEMBER_TOKEN_PREFIX) ? header : null
}

/**
 * Resolves the member behind `X-Member-Token`, if any. A token only counts for the site it was
 * issued on, so a member of the blog cannot unlock gated content on the docs site.
 */
export const resolveMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('member', await memberFromToken(c))
  await next()
}

async function memberFromToken(c: Context<AppEnv>): Promise<MemberRow | null> {
  const token = memberToken(c)
  if (!token) return null

  const site = c.get('site')
  if (!site) return null

  const [row] = await getDb(c.env)
    .select({ member: members })
    .from(memberSessions)
    .innerJoin(members, eq(members.id, memberSessions.memberId))
    .where(
      and(
        eq(memberSessions.id, await hmac(c.env.AUTH_SECRET, token)),
        gt(memberSessions.expiresAt, Math.floor(Date.now() / 1000)),
        eq(members.siteId, site.id),
        eq(members.status, 'active'),
      ),
    )
    .limit(1)

  return row?.member ?? null
}

export function requireMember(c: Context<AppEnv>): MemberRow {
  const member = c.get('member')
  if (!member) throw ApiError.unauthorized('This content requires a signed-in member')
  return member
}
