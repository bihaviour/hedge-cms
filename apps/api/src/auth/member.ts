import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { MEMBER_MAGIC_LINK_TTL_MINUTES } from '@hedge/core'
import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { magicLink } from 'better-auth/plugins/magic-link'
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
import { currentRequestSite } from '../lib/site'

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

        // A member belongs to a site, so the email goes out as that site — its sender if it has one
        // of its own, and its name in the body either way. Nothing here can be handed the site, so
        // it comes from the request in flight.
        const site = currentRequestSite()
        await sendEmail(
          env,
          await renderEmail(env, key, { to: user.email, name: user.name, url: setUrl }, site),
          { templateKey: key, site },
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
        const site = currentRequestSite()
        await sendEmail(
          env,
          await renderEmail(env, 'member_verify', { to: user.email, name: user.name, url }, site),
          { templateKey: 'member_verify', site },
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

      /**
       * Sign-in by emailed link, for the reader who lands on a gated page from a search result and
       * has no application to be handed over from (#108).
       *
       * Three things here are decisions rather than defaults:
       *
       * - **`disableSignUp`.** Left off, the plugin creates an account at *verify* time for any
       *   address a link was sent to. The facade knows the site and refuses an unknown address
       *   before a link is ever mailed; the plugin does not, so an invite-only site would collect
       *   an identity per address anyone typed into the form and then refuse each of them a grant.
       *   Registering stays `POST /member/register`, which is an act the reader takes on purpose.
       * - **`storeToken: 'hashed'`.** The raw token sits in an inbox; only its digest is worth
       *   keeping here, for the same reason a password is not stored as one.
       * - **A verified sign-in.** Redeeming the link flips `emailVerified`, because clicking a link
       *   in an inbox is a more direct proof of the address than the verification mail is. Better
       *   Auth also **drops the password** on an account that was not yet verified: a credential
       *   set before anybody proved they own the mailbox is not evidence of anything, and the
       *   member is left signed in and able to choose a new one. It surfaces as the account
       *   showing *invited* again in the admin, which is honest — it has no password.
       */
      magicLink({
        expiresIn: MEMBER_MAGIC_LINK_TTL_MINUTES * 60,
        disableSignUp: true,
        storeToken: 'hashed',
        /**
         * The plugin builds a link at Better Auth's own base path; the one that gets mailed points
         * at the facade instead, because the facade is what applies the site's grant rules before
         * a token becomes a signed-in reader. Both the site and the landing page ride along in the
         * URL — nothing else survives the round trip through the reader's inbox.
         */
        sendMagicLink: async ({ email, url, token, metadata }) => {
          const site = currentRequestSite()
          const verify = new URL(`${env.PUBLIC_URL}/api/v1/member/magic-link/verify`)
          verify.searchParams.set('token', token)
          if (site) verify.searchParams.set('site', site.slug)

          // `callbackURL` is the facade's already-validated landing page. The plugin defaults it to
          // "/" when none was asked for, which is not a page on anybody's website.
          const redirect = callbackFrom(url)
          if (redirect && /^https?:\/\//.test(redirect))
            verify.searchParams.set('redirect', redirect)

          const name = typeof metadata?.name === 'string' ? metadata.name : email

          await sendEmail(
            env,
            await renderEmail(
              env,
              'member_magic_link',
              { to: email, name, url: verify.toString() },
              site,
            ),
            { templateKey: 'member_magic_link', site },
          )
        },
      }),
    ],
  })
}

/**
 * Creates a member session directly, for a caller that has authenticated the reader somewhere else
 * (`POST /api/v1/member-sessions`, #108).
 *
 * It goes through Better Auth's own session creation rather than writing `member_sessions` by hand,
 * so the row is the one a sign-in would have produced — same `mss` id, same token generation, same
 * expiry — and `/member/me`, logout and the daily rotation cannot tell the two apart. Anything
 * hand-rolled here would be a second definition of a session to keep in step with the first.
 *
 * **Minting a session is not knowing a credential.** Nothing here reads or sets a password, so the
 * rule that only a member ever knows theirs survives intact; the caller is asserting an identity it
 * has already proven for itself, which is what every SSO handoff does.
 */
export async function mintMemberSession(
  env: Bindings,
  memberId: string,
  request: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: string }> {
  const ctx = await getMemberAuth(env).$context
  const session = await ctx.internalAdapter.createSession(memberId, false, {
    // The trusted server's address and agent, not the reader's — this session was created for its
    // request, and recording the reader's browser would be a guess dressed up as a fact.
    ipAddress: request.ipAddress ?? '',
    userAgent: request.userAgent ?? '',
  })

  return { token: session.token, expiresAt: new Date(session.expiresAt).toISOString() }
}

/** Ends one member session by its token. Used where a session was minted and then refused. */
export async function revokeMemberSession(env: Bindings, token: string): Promise<void> {
  const ctx = await getMemberAuth(env).$context
  await ctx.internalAdapter.deleteSession(token)
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
