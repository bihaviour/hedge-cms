import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SITE_HEADER } from '@hedge/core'

/**
 * The admin remembers which site you were in, and sends it on every request — including the one
 * that asks who you are. So a site that goes away while you have it selected used to lock you out
 * of the whole app: `/auth/me` answered 404, which reads as "not signed in", and signing in again
 * changed nothing because the header was still there.
 */

// The module under test keeps the remembered site in `localStorage`, which the test runner has no
// DOM to provide. Defined before the import, because that read happens as the module evaluates.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  },
})

const { getActiveSite, setActiveSite } = await import('./active-site')
const { api, ApiClientError } = await import('./api')

const realFetch = globalThis.fetch
let calls: { url: string; site: string | null }[] = []

/** Answers `unknown_site` for the named slug and succeeds for anything else. */
function apiThatForgot(missing: string) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const site = new Headers(init?.headers).get(SITE_HEADER)
    calls.push({ url, site })

    if (site === missing) {
      return Response.json(
        { error: { code: 'unknown_site', message: `No site matches "${site}"` } },
        { status: 404 },
      )
    }
    return Response.json({ data: { id: 'usr_1', email: 'owner@example.com' } })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  globalThis.fetch = realFetch
  setActiveSite(null)
})

describe('the remembered site', () => {
  test('is dropped and the request retried when the API no longer knows it', async () => {
    setActiveSite('deleted-site')
    apiThatForgot('deleted-site')

    const user = await api.auth.me()

    expect(user.email).toBe('owner@example.com')
    expect(calls.map((call) => call.site)).toEqual(['deleted-site', null])
    // Cleared, so the site switcher falls back to the first site the account can reach.
    expect(getActiveSite()).toBeNull()
  })

  test('survives a 404 that is about anything else', async () => {
    setActiveSite('blog')
    globalThis.fetch = (async () =>
      Response.json(
        { error: { code: 'not_found', message: 'Collection not found' } },
        { status: 404 },
      )) as unknown as typeof fetch

    const failure = await api.collections.get('gone').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiClientError)
    expect(getActiveSite()).toBe('blog')
  })

  test('is left alone when nothing was remembered', async () => {
    apiThatForgot('deleted-site')

    await api.auth.me()

    expect(calls).toHaveLength(1)
    expect(getActiveSite()).toBeNull()
  })
})
