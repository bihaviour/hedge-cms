import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AppEnv } from '../env'

/**
 * The update check's caching, and the `?refresh=1` escape hatch from it.
 *
 * The cache is not an optimisation here — GitHub's unauthenticated limit is per egress IP and that
 * IP is shared with every other Worker on the colo, so a check that reached the network on every
 * admin page load would spend a budget that is not this deployment's alone. These pin both halves:
 * that the ordinary path stays cached, and that the one path allowed to skip it actually does.
 */

/** A stand-in for the Workers Cache API, recording what was read and written. */
class FakeCache {
  store = new Map<string, string>()
  matches = 0
  puts = 0

  async match(key: Request) {
    this.matches++
    const hit = this.store.get(key.url)
    return hit === undefined ? undefined : new Response(hit)
  }

  async put(key: Request, response: Response) {
    this.puts++
    this.store.set(key.url, await response.text())
  }
}

let cache: FakeCache
let fetches: string[]
const originalFetch = globalThis.fetch

/**
 * The limiter counts in the database, which this test has no need of. Stubbed to a recorder so the
 * cache semantics can be exercised — and so the *presence* of the limit on the forced path can be
 * asserted, which is the part that keeps a refresh button from being a way to spend the colo's
 * shared GitHub budget.
 */
const throttled: string[] = []
mock.module('../lib/throttle', () => ({
  throttle: async (_c: unknown, action: string) => {
    throttled.push(action)
  },
}))

const release = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  published_at: '2026-08-01T00:00:00Z',
  draft: false,
  prerelease: false,
})

beforeEach(() => {
  cache = new FakeCache()
  fetches = []
  throttled.length = 0
  // @ts-expect-error — the runtime global only exists in workerd; the module feature-detects it.
  globalThis.caches = { default: cache }

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input))
    return new Response(JSON.stringify(release('v1.2.3')), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  // @ts-expect-error — clean up the global the test installed.
  globalThis.caches = undefined
  mock.restore()
})

/**
 * The module reads `caches` at call time, so it is imported fresh per test after the global is in
 * place. `latestRelease` is not exported — it is exercised through the route's own handler.
 */
async function loadRoute() {
  const mod = await import(`./system.ts?bust=${fetches.length}-${Math.random()}`)
  return mod.default
}

/** Calls `GET /version` with the permission middleware satisfied by a stub actor. */
async function getVersion(query = '') {
  const app = await loadRoute()
  const { Hono } = await import('hono')
  const outer = new Hono<AppEnv>()
  // `requirePermission` reads the actor off the context; a stub owner clears it without dragging in
  // the database that resolving a real session would.
  outer.use('*', async (c, next) => {
    c.set('actor', {
      kind: 'user',
      id: 'usr_1',
      role: 'owner',
      via: 'session',
      permissions: ['system:read'],
      scopes: [],
      siteId: null,
    })
    await next()
  })
  outer.route('/system', app)
  return outer.fetch(new Request(`https://cms.example.com/system/version${query}`), {
    AUTH_SECRET: 'x',
    PUBLIC_URL: 'https://cms.example.com',
  } as never)
}

describe('the update check', () => {
  test('asks GitHub once and serves the rest from cache', async () => {
    const first = await getVersion()
    expect(first.status).toBe(200)
    expect(fetches).toHaveLength(1)
    expect(cache.puts).toBe(1)

    // A second load must not reach the network — that is the whole point of the cache.
    await getVersion()
    expect(fetches).toHaveLength(1)
  })

  test('caches a failed check too, so one bad moment is not a retry storm', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetches.push(String(input))
      return new Response('rate limited', { status: 403 })
    }) as typeof fetch

    await getVersion()
    await getVersion()
    expect(fetches).toHaveLength(1)
  })

  test('?refresh=1 skips the cache and asks GitHub again', async () => {
    await getVersion()
    expect(fetches).toHaveLength(1)

    const forced = await getVersion('?refresh=1')
    expect(forced.status).toBe(200)
    // The operator has just published a release; waiting out the TTL is the thing to avoid.
    expect(fetches).toHaveLength(2)
  })

  test('a forced check writes its answer back, so the next caller benefits', async () => {
    await getVersion('?refresh=1')
    expect(cache.puts).toBe(1)

    await getVersion()
    // Served from what the forced check stored, not from a second network call.
    expect(fetches).toHaveLength(1)
  })

  test('any other query value leaves the cache in charge', async () => {
    await getVersion()
    await getVersion('?refresh=0')
    await getVersion('?refresh=true')
    expect(fetches).toHaveLength(1)
  })

  test('only the forced path is rate limited', async () => {
    await getVersion()
    // The cached path costs nothing and must not spend anyone's limiter budget.
    expect(throttled).toEqual([])

    await getVersion('?refresh=1')
    // …while the one path that can reach GitHub on demand is bounded.
    expect(throttled).toEqual(['system-version-refresh'])
  })
})
