import { MEMBER_TOKEN_HEADER } from '@hedge/core'
import { and, eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getMemberAuth } from '../auth/member'
import { getDb } from '../db/client'
import { type MemberRow, type MemberSiteRow, memberSites } from '../db/schema'
import type { AppEnv, Bindings } from '../env'
import { ApiError } from './errors'

/**
 * Member sessions are bearer tokens, not cookies: a member signs in on the website Hedge feeds,
 * which is a different origin, and the token is what that site stores and replays.
 *
 * It travels in `X-Member-Token` rather than `Authorization` because a website sends both at once —
 * its delivery API key identifies the site, the member token identifies the reader.
 *
 * Nothing here can produce an `Actor`. The token belongs to a different Better Auth instance over
 * different tables, so it is not merely rejected by the management API — it is unresolvable there.
 */
export const resolveMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('member', await memberFromToken(c))
  await next()
}

async function memberFromToken(c: Context<AppEnv>): Promise<MemberRow | null> {
  const token = c.req.header(MEMBER_TOKEN_HEADER)?.trim()
  if (!token) return null

  const site = c.get('site')
  if (!site) return null

  const session = await getMemberAuth(c.env).api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  })
  if (!session) return null

  // A valid token proves who the reader is; the grant is what says they belong to *this* site.
  const grant = await memberGrant(c.env, session.user.id, site.id)
  if (grant?.status !== 'active') return null

  return session.user as MemberRow
}

/** A member's access to one site, or `null` when they have none. */
export async function memberGrant(
  env: Bindings,
  memberId: string,
  siteId: string,
): Promise<MemberSiteRow | null> {
  const [grant] = await getDb(env)
    .select()
    .from(memberSites)
    .where(and(eq(memberSites.memberId, memberId), eq(memberSites.siteId, siteId)))
    .limit(1)

  return grant ?? null
}

export function requireMember(c: Context<AppEnv>): MemberRow {
  const member = c.get('member')
  if (!member) throw ApiError.unauthorized('This content requires a signed-in member')
  return member
}
