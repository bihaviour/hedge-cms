import { describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import type { AppEnv } from '../env'
import { forwardToAuth } from './forward'

// What matters here is the *request Better Auth is handed*, not what it answers with: the bug this
// pins was a cookie we passed through that made its `mcp` after-hook resume the OAuth flow itself
// and reply `302`, which this facade could only report as `internal_error`.

/** A context that carries the given request headers and records what the handler was called with. */
function contextWith(headers: Record<string, string>) {
  const seen: { request?: Request } = {}

  const c = {
    env: { PUBLIC_URL: 'https://cms.example.com' },
    req: { header: (name: string) => headers[name] },
  } as unknown as Context<AppEnv>

  const auth = {
    options: { basePath: '/api/v1/auth' },
    handler: async (request: Request) => {
      seen.request = request
      return Response.json({ ok: true })
    },
  }

  return { c, auth, seen }
}

/** The `Cookie` header Better Auth received for a sign-in forwarded with `cookie`. */
async function forwardedCookie(cookie: string | undefined) {
  const { c, auth, seen } = contextWith(cookie ? { cookie } : {})
  await forwardToAuth(c, auth, '/sign-in/email', { email: 'a@example.com', password: 'pw' })
  return seen.request?.headers.get('cookie')
}

describe('forwardToAuth', () => {
  test('hides the pending-authorization cookie from Better Auth', async () => {
    expect(
      await forwardedCookie('hedge.session_token=abc; oidc_login_prompt=xyz; theme=dark'),
    ).toBe('hedge.session_token=abc; theme=dark')
  })

  test('drops the header when that was the only cookie', async () => {
    expect(await forwardedCookie('oidc_login_prompt=xyz')).toBeNull()
  })

  test('leaves the leading cookie unpadded when it is the one removed', async () => {
    expect(await forwardedCookie('oidc_login_prompt=xyz; hedge.session_token=abc')).toBe(
      'hedge.session_token=abc',
    )
  })

  test('passes every other cookie through untouched', async () => {
    expect(await forwardedCookie('hedge.session_token=abc; theme=dark')).toBe(
      'hedge.session_token=abc; theme=dark',
    )
  })

  // The guard is a substring test for speed, so a cookie merely *named* like it must survive.
  test('matches the cookie name exactly', async () => {
    expect(await forwardedCookie('app_oidc_login_prompt=xyz')).toBe('app_oidc_login_prompt=xyz')
  })

  test('sends no cookie header when the request had none', async () => {
    expect(await forwardedCookie(undefined)).toBeNull()
  })
})
