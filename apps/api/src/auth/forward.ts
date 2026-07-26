import type { ApiErrorCode } from '@hedge/core'
import type { Context } from 'hono'
import type { AppEnv } from '../env'
import { ApiError } from '../lib/errors'

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

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'bad_request',
  429: 'rate_limited',
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
    const value = c.req.header(name)
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
    const code = CODE_BY_STATUS[response.status] ?? 'internal_error'
    const message = payload?.message ?? 'Authentication failed'
    if (code === 'internal_error') {
      // Better Auth logs the cause itself, but not what was being attempted — without the path
      // here, a 500 on sign-in and a 500 on a password change are the same line in `wrangler tail`.
      console.error('better-auth error', path, response.status, payload)
      throw new ApiError(
        'internal_error',
        'The authentication service failed. The cause is in this deployment’s Worker logs.',
      )
    }
    throw new ApiError(code, message)
  }

  return { payload: payload as T, cookies: response.headers.getSetCookie() }
}

/** Copies Better Auth's cookies onto the response we are about to send. */
export function applyCookies(c: Context<AppEnv>, cookies: string[]): void {
  for (const cookie of cookies) c.header('set-cookie', cookie, { append: true })
}
