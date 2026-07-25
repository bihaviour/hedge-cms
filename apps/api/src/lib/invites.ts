import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { accounts, authTokens, type UserRow } from '../db/schema'
import { sendEmail } from '../email/send'
import { inviteEmail } from '../email/templates'
import type { Bindings } from '../env'
import { hmac, randomToken } from './crypto'
import { newId } from './id'

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7

/**
 * Emails a user the link that lets them choose their first password — the only way an account
 * here is ever activated, since nobody but the invitee sets their credential.
 *
 * Any invite still outstanding for them is spent first. A resent link replaces the old one rather
 * than adding a second key to the same door, so an invite forwarded to the wrong inbox stops
 * working the moment a new one is sent.
 */
export async function sendUserInvite(env: Bindings, user: UserRow): Promise<void> {
  const db = getDb(env)

  await db
    .update(authTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(
      and(
        eq(authTokens.userId, user.id),
        eq(authTokens.purpose, 'invite'),
        isNull(authTokens.usedAt),
      ),
    )

  const token = randomToken(32)
  await db.insert(authTokens).values({
    id: newId('tok'),
    userId: user.id,
    purpose: 'invite',
    tokenHash: await hmac(env.AUTH_SECRET, token),
    expiresAt: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
  })

  await sendEmail(env, inviteEmail(env, { to: user.email, name: user.name, token }))
}

/**
 * Whether this user has a password at all. Its absence is what "pending" means: an invited user
 * has a row from the moment they are invited, and a credential only once they accept.
 */
export async function hasCredential(env: Bindings, userId: string): Promise<boolean> {
  const [row] = await getDb(env)
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')))
    .limit(1)

  return row !== undefined
}
