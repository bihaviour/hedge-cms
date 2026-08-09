import type { Context } from 'hono'
import type { AppEnv } from '../env'
import { authError } from './errors'

/** Headers Better Auth reads: the session cookie, the origin it checks, and the client's identity. */
const FORWARDED_HEADERS = [
  'cookie',
  'origin',
  'referer',
  'user-agent',
  'accept-language',
  'cf-connecting-ip',
  'x-forwarded-for',
] as const

/**
 * Better Auth's `mcp` plugin parks a pending authorization request in this cookie when `/authorize`
 * finds no session, and its after-hook — which matches *every* endpoint — resumes the OAuth flow
 * server-side the moment any response sets a session cookie. Through this facade that lands as a
 * `302` on `/sign-in/email`, which is not a status a JSON API can return to `fetch`, so signing in
 * failed with `internal_error` for anyone who reached `/login` from an MCP client.
 *
 * Hedge already resumes the request itself, from the admin (`resumeAuthorization` in
 * `lib/oauth.ts`), so the server-side resume is redundant here as well as harmful. Dropping the
 * cookie on the way in is what turns it off: the hook reads it with `getSignedCookie` and returns
 * early when it is absent. The browser keeps its copy — this only hides it from the forwarded
 * request — and the next `/authorize` sees the session it now has.
 */
const OIDC_LOGIN_PROMPT_COOKIE = 'oidc_login_prompt'

/** Rebuilds a `Cookie` header without the pending-authorization cookie. */
function withoutLoginPrompt(cookie: string | undefined): string | undefined {
  if (!cookie?.includes(OIDC_LOGIN_PROMPT_COOKIE)) return cookie
  const kept = cookie
    .split(';')
    .filter((pair) => pair.trimStart().split('=')[0]?.trim() !== OIDC_LOGIN_PROMPT_COOKIE)
    .join(';')
    .trim()
  return kept || undefined
}

interface ForwardResult<T> {
  payload: T
  /** `Set-Cookie` values Better Auth produced — the caller has to copy them onto its own response. */
  cookies: string[]
}

/**
 * Calls a Better Auth endpoint through its own HTTP handler rather than through `auth.api`.
 *
 * It looks like the long way round, but the handler is where rate limiting, the `Origin` check and
 * cookie signing live. Calling `auth.api.signInEmail` directly would skip all three, so the facade
 * would be a way to brute-force passwords that the endpoint it wraps is protected against.
 */
export async function forwardToAuth<T>(
  c: Context<AppEnv>,
  auth: { handler: (request: Request) => Promise<Response>; options: { basePath?: string } },
  path: string,
  body?: unknown,
): Promise<ForwardResult<T>> {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const name of FORWARDED_HEADERS) {
    const value = name === 'cookie' ? withoutLoginPrompt(c.req.header(name)) : c.req.header(name)
    if (value) headers.set(name, value)
  }

  const url = new URL(`${auth.options.basePath ?? '/api/auth'}${path}`, c.env.PUBLIC_URL)
  const response = await auth.handler(
    new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    }),
  )

  const payload = (await response.json().catch(() => null)) as
    | (T & { message?: string; code?: string })
    | null

  if (!response.ok) {
    throw authError(response.status, payload?.message ?? 'Authentication failed', path, payload)
  }

  return { payload: payload as T, cookies: response.headers.getSetCookie() }
}

/** Copies Better Auth's cookies onto the response we are about to send. */
export function applyCookies(c: Context<AppEnv>, cookies: string[]): void {
  for (const cookie of cookies) c.header('set-cookie', cookie, { append: true })
}
