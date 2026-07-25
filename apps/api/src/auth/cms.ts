import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { MCP_SCOPES, OAUTH_CONSENT_PATH } from '@hedge/core'
import { betterAuth } from 'better-auth'
import { mcp } from 'better-auth/plugins'
import { getDb } from '../db/client'
import {
  accounts,
  oauthAccessTokens,
  oauthApplications,
  oauthConsents,
  rateLimits,
  sessions,
  users,
  verifications,
} from '../db/schema'
import { sendEmail } from '../email/send'
import { passwordResetEmail } from '../email/templates'
import type { Bindings } from '../env'
import { hashPassword, verifyPassword } from '../lib/crypto'
import { newId } from '../lib/id'

/** Where Better Auth's own endpoints live. The hedge facade in `routes/auth.ts` shares the prefix. */
export const CMS_AUTH_BASE_PATH = '/api/v1/auth'

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
/** How often an in-use session is extended and its token rotated. */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24
/** A password change or a session revoke has to be done with a session younger than this. */
const SESSION_FRESH_AGE_SECONDS = 60 * 60 * 24

const ID_PREFIX_BY_MODEL: Record<string, string> = {
  user: 'usr',
  session: 'ses',
  account: 'acc',
  verification: 'ver',
  rateLimit: 'rlm',
  oauthApplication: 'oac',
  oauthAccessToken: 'oat',
  oauthConsent: 'ocs',
}

export type CmsAuth = ReturnType<typeof createCmsAuth>

/**
 * Authentication for people who operate the CMS.
 *
 * Better Auth owns identity here — sessions, password hashing, verification tokens, the OAuth
 * server the MCP endpoint sits behind. Authorisation is still ours: `users.role` and `site_users`
 * decide what a caller may touch, and nothing in this file reads them.
 *
 * Members are a *separate* instance (`auth/member.ts`) over separate tables, so a member session
 * token is not merely rejected here — it is unresolvable, and no bug in a role check can promote
 * one into a CMS user.
 */
function createCmsAuth(env: Bindings) {
  const isProduction = env.ENVIRONMENT === 'production'

  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.PUBLIC_URL,
    basePath: CMS_AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    // Nothing about a self-hosted CMS should phone home.
    telemetry: { enabled: false },

    database: drizzleAdapter(getDb(env), {
      provider: 'sqlite',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: rateLimits,
        oauthApplication: oauthApplications,
        oauthAccessToken: oauthAccessTokens,
        oauthConsent: oauthConsents,
      },
    }),

    /**
     * The admin UI is served from the same origin as the API, so the session is a cookie. Better
     * Auth signs it, checks `Origin` against `trustedOrigins` on every state-changing request, and
     * rotates the token whenever the session is refreshed.
     */
    trustedOrigins: isProduction
      ? [env.PUBLIC_URL]
      : [env.PUBLIC_URL, 'http://localhost:5173', 'http://localhost:8787'],

    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      freshAge: SESSION_FRESH_AGE_SECONDS,
    },

    user: {
      additionalFields: {
        // Set when a user is invited, and only ever changed through `/api/v1/users` — never by
        // the client, or an invitee could accept their invite as an owner.
        role: {
          type: ['owner', 'admin', 'editor', 'viewer'],
          required: false,
          defaultValue: 'editor',
          input: false,
        },
      },
    },

    emailAndPassword: {
      enabled: true,
      /**
       * There is no public sign-up on a CMS: the first owner comes from `/setup` and everyone else
       * from an invite. This closes Better Auth's own `/sign-up/email`, which the handler would
       * otherwise expose at `/api/v1/auth/sign-up/email` to anyone who found it.
       */
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 200,
      autoSignIn: true,
      /**
       * A reset is how someone who has lost control of their password recovers — so it also ends
       * every session opened with the old one.
       */
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, token }) => {
        await sendEmail(env, passwordResetEmail(env, { to: user.email, name: user.name, token }))
      },
      /**
       * PBKDF2-SHA256 via Web Crypto, the same primitive the pre-Better-Auth code used and in the
       * same `pbkdf2$iterations$salt$hash` format — so every password already in the database keeps
       * working, and no user is forced through a reset by this migration.
       */
      password: {
        hash: hashPassword,
        verify: ({ password, hash }) => verifyPassword(password, hash),
      },
    },

    /**
     * Backed by the database, not memory: a Worker isolate is short-lived and there are many of
     * them, so an in-memory counter would let a guessing loop reset its own budget just by being
     * routed somewhere new.
     */
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 300, max: 10 },
        '/request-password-reset': { window: 900, max: 5 },
        '/reset-password': { window: 900, max: 10 },
        '/mcp/token': { window: 60, max: 30 },
        '/mcp/register': { window: 3600, max: 20 },
      },
    },

    advanced: {
      cookiePrefix: 'hedge',
      useSecureCookies: isProduction,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      database: {
        // Keep Better Auth's rows readable next to ours: same sortable, prefixed id format.
        generateId: ({ model }) => newId(ID_PREFIX_BY_MODEL[model] ?? 'ba'),
      },
    },

    plugins: [
      /**
       * OAuth 2.1 for MCP clients: dynamic client registration, authorization code + PKCE, and
       * refresh tokens, all against the admin session the operator already has. An MCP client
       * ends up holding a short-lived token bound to one user — not a shared API key.
       */
      mcp({
        loginPage: '/login',
        // RFC 9728: the resource is the MCP endpoint itself, not the deployment.
        resource: `${env.PUBLIC_URL}/api/v1/mcp`,
        oidcConfig: {
          loginPage: '/login',
          requirePKCE: true,
          allowPlainCodeChallengeMethod: false,
          consentPage: OAUTH_CONSENT_PATH,
          accessTokenExpiresIn: 60 * 60,
          refreshTokenExpiresIn: 60 * 60 * 24 * 30,
          defaultScope: `openid ${MCP_SCOPES.collectionsRead}`,
          scopes: [MCP_SCOPES.collectionsRead, MCP_SCOPES.collectionsWrite],
          metadata: {
            scopes_supported: [
              'openid',
              'profile',
              'email',
              'offline_access',
              MCP_SCOPES.collectionsRead,
              MCP_SCOPES.collectionsWrite,
            ],
          },
        },
      }),
    ],
  })
}

/**
 * One instance per isolate rather than per request. Constructing it parses the config and builds
 * the plugin route table, which is wasted work on every call; `env` is stable for the life of an
 * isolate, so caching against it is safe and drops the cost to first-request-only.
 */
const cache = new WeakMap<Bindings, CmsAuth>()

export function getCmsAuth(env: Bindings): CmsAuth {
  const existing = cache.get(env)
  if (existing) return existing

  const auth = createCmsAuth(env)
  cache.set(env, auth)
  return auth
}
