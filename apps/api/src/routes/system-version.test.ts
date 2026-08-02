import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SystemVersion } from '@hedge/core'
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

const release = (tag: string, overrides: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  body: `## What's Changed\n* something in ${tag}`,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  published_at: '2026-08-01T00:00:00Z',
  draft: false,
  prerelease: false,
  ...overrides,
})

/** Answer the release list with these rows, recording the URL that was asked for. */
function respondWith(rows: unknown[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input))
    return new Response(JSON.stringify(rows), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

beforeEach(() => {
  cache = new FakeCache()
  fetches = []
  throttled.length = 0
  // @ts-expect-error — the runtime global only exists in workerd; the module feature-detects it.
  globalThis.caches = { default: cache }

  respondWith([release('v1.2.3')])
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

  test('asks for a page of releases, not just the latest one', async () => {
    await getVersion()
    // One call answers both questions the About page asks — "is there a newer version?" and "what
    // changed?" — so the changelog costs nothing extra against GitHub's shared rate limit.
    expect(fetches).toEqual([
      'https://api.github.com/repos/bihaviour/hedge-cms/releases?per_page=10',
    ])
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

/**
 * The changelog the About page renders. "A newer version exists" is not something an operator can
 * act on; what it changes is, so the notes travel with the check rather than as a link away from it.
 */
describe('the changelog', () => {
  const body = async (query = '') =>
    (await (await getVersion(query)).json()) as { data: SystemVersion }

  test('carries each release with its notes, newest first', async () => {
    respondWith([release('v1.2.3'), release('v1.2.2')])

    const { data } = await body()
    expect(data.releases).toEqual([
      expect.objectContaining({ version: 'v1.2.3', notes: expect.stringContaining('v1.2.3') }),
      expect.objectContaining({ version: 'v1.2.2', truncated: false }),
    ])
    // The head of the same list is the update check, so the two can never disagree.
    expect(data.latest).toBe('v1.2.3')
  })

  test('leaves drafts and prereleases out of both the check and the changelog', async () => {
    respondWith([
      release('v2.0.0-rc.1', { prerelease: true }),
      release('v2.0.0-draft', { draft: true }),
      release('v1.2.3'),
    ])

    const { data } = await body()
    // A note about work in progress reads as a note about a release; neither belongs here.
    expect(data.releases.map((row) => row.version)).toEqual(['v1.2.3'])
    expect(data.latest).toBe('v1.2.3')
  })

  test('shortens an outsized body and says that it did', async () => {
    respondWith([release('v1.2.3', { body: `${'a line about a change\n'.repeat(400)}` })])

    const { data } = await body()
    const note = data.releases[0]
    // The banner shares this response, so it rides along on every admin page load — an upstream
    // that one day pastes a migration guide into a release must not make that payload unbounded.
    expect(note?.truncated).toBe(true)
    expect(note?.notes.length).toBeLessThanOrEqual(4000)
    // Cut at a line break, so the last line rendered is a whole one.
    expect(note?.notes.endsWith('a line about a change')).toBe(true)
  })

  test('a release with no notes is still listed', async () => {
    respondWith([release('v1.2.3', { body: null, name: null })])

    const { data } = await body()
    expect(data.releases).toEqual([
      expect.objectContaining({ version: 'v1.2.3', name: null, notes: '' }),
    ])
  })

  test('an unreachable GitHub degrades to an empty changelog, not an error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    const { data } = await body()
    expect(data.releases).toEqual([])
    expect(data.latest).toBeNull()
    expect(data.updateAvailable).toBe(false)
  })
})
