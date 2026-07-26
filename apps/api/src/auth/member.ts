import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import {
  memberAccounts,
  memberSessions,
  members,
  memberVerifications,
  rateLimits,
} from '../db/schema'
import { renderEmail } from '../email/render'
import { sendEmail } from '../email/send'
import type { Bindings } from '../env'
import { hashPassword, verifyPassword } from '../lib/crypto'
import { newId } from '../lib/id'

/**
 * Better Auth's own member endpoints. The documented member API is the facade at `/api/v1/member`;
 * this prefix exists because email links have to point at a real GET route.
 */
export const MEMBER_AUTH_BASE_PATH = '/api/v1/member/auth'

const MEMBER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const MEMBER_SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24

const ID_PREFIX_BY_MODEL: Record<string, string> = {
  user: 'mem',
  session: 'mss',
  account: 'mac',
  verification: 'mvr',
  rateLimit: 'rlm',
}

export type MemberAuth = ReturnType<typeof createMemberAuth>

/**
 * Authentication for the audience of a site — people who sign in on the website Hedge feeds, not
 * in the admin.
 *
 * A second Better Auth instance over its own tables, which is the whole security argument: the CMS
 * instance has no way to resolve anything issued here, so a member token cannot be mistaken for an
 * operator's session no matter what a route forgets to check.
 *
 * Sessions are bearer tokens rather than cookies because a member signs in from a different origin
 * — there is no cookie this Worker could set for them. That makes them the one credential type a
 * website frontend replays, alongside its delivery API key.
 */
function createMemberAuth(env: Bindings) {
  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.PUBLIC_URL,
    basePath: MEMBER_AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    telemetry: { enabled: false },

    database: drizzleAdapter(getDb(env), {
      provider: 'sqlite',
      schema: {
        user: members,
        session: memberSessions,
        account: memberAccounts,
        verification: memberVerifications,
        rateLimit: rateLimits,
      },
    }),

    session: {
      expiresIn: MEMBER_SESSION_TTL_SECONDS,
      // An active member's token is rotated daily, so a leaked one stops working on its own.
      updateAge: MEMBER_SESSION_UPDATE_AGE_SECONDS,
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 200,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      // A day rather than Better Auth's hour: this same link is what an admin-added member gets as
      // their invite, and a reader who checks mail once a day should not arrive to a dead link.
      resetPasswordTokenExpiresIn: 60 * 60 * 24,
      /**
       * The reset link points at the website, not at the CMS: `redirectTo` is checked against the
       * site's own domain by the facade before it gets here, so this cannot be turned into an open
       * redirect by asking for a reset.
       *
       * A member with no credential yet has nothing to reset — they were added by an admin, who
       * cannot set a password for them. So the same link is sent as an invitation instead.
       */
      sendResetPassword: async ({ user, url, token }) => {
        const setUrl = withToken(callbackFrom(url) ?? `${env.PUBLIC_URL}/reset-password`, token)
        const invited = !(await hasCredential(env, user.id))
        const key = invited ? 'member_invite' : 'member_reset'

        await sendEmail(
          env,
          await renderEmail(env, key, { to: user.email, name: user.name, url: setUrl }),
          { templateKey: key },
        )
      },
      password: {
        hash: hashPassword,
        verify: ({ password, hash }) => verifyPassword(password, hash),
      },
    },

    /**
     * Sent on registration but not enforced: a site decides for itself whether an unverified
     * reader may unlock gated content, and `emailVerified` is what it reads to decide. Enforcing it
     * here would lock out members created by an admin before they ever see an email.
     */
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, token }) => {
        const url = `${env.PUBLIC_URL}/api/v1/member/verify-email?token=${encodeURIComponent(token)}`
        await sendEmail(
          env,
          await renderEmail(env, 'member_verify', { to: user.email, name: user.name, url }),
          { templateKey: 'member_verify' },
        )
      },
    },

    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
    },

    advanced: {
      database: {
        generateId: ({ model }) => newId(ID_PREFIX_BY_MODEL[model] ?? 'mba'),
      },
    },

    plugins: [
      /**
       * Hands the session token back in `set-auth-token` instead of a cookie, and accepts it as
       * `Authorization: Bearer`. The facade re-shapes that into the `{ token, expiresAt, member }`
       * body a website already expects.
       */
      bearer(),
    ],
  })
}

/**
 * Whether this member has a password at all.
 *
 * The absence of one is what "pending" means everywhere in Hedge: an admin can add a member, but
 * cannot choose a credential for them, so the account stays half-made until they follow the link.
 */
export async function hasCredential(env: Bindings, memberId: string): Promise<boolean> {
  const [row] = await getDb(env)
    .select({ id: memberAccounts.id })
    .from(memberAccounts)
    .where(and(eq(memberAccounts.userId, memberId), eq(memberAccounts.providerId, 'credential')))
    .limit(1)

  return row !== undefined
}

/** Pulls the `callbackURL` Better Auth embeds in the reset link it builds. */
function callbackFrom(url: string): string | null {
  try {
    return new URL(url).searchParams.get('callbackURL')
  } catch {
    return null
  }
}

function withToken(base: string, token: string): string {
  const url = new URL(base)
  url.searchParams.set('token', token)
  return url.toString()
}

const cache = new WeakMap<Bindings, MemberAuth>()

export function getMemberAuth(env: Bindings): MemberAuth {
  const existing = cache.get(env)
  if (existing) return existing

  const auth = createMemberAuth(env)
  cache.set(env, auth)
  return auth
}
