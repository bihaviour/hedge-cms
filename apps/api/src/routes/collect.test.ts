import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import type { AppEnv } from '../env'

// The collector is a public write path, so what is tested here is what it *refuses* to do: write
// for a reader who opted out, write for a crawler, write anything at all for a request that
// resolved no site — and, whatever happens, tell the caller nothing.

interface Recorded {
  siteId: string
  path: string
  event: string
  referrer: string | null
}

let recorded: Recorded[] = []

// `mock.module` is process-wide and outlives this file, so the replacement keeps every export the
// real module has — anything dropped becomes an import error in whichever test file runs next.
const realAnalytics = await import('../lib/analytics')
const realThrottle = await import('../lib/throttle')

mock.module('../lib/analytics', () => ({
  ...realAnalytics,
  recordEvent: async (
    _env: unknown,
    site: { id: string },
    input: { path: string; event: string },
    referrer: string | null,
  ) => {
    recorded.push({ siteId: site.id, path: input.path, event: input.event, referrer })
  },
}))

// The real limiter counts in D1. Which requests are counted is `throttle`'s own test; this file is
// about the handler around it.
mock.module('../lib/throttle', () => ({ ...realThrottle, throttle: async () => {} }))

const { default: collect } = await import('./collect')

const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

/** Posts one beacon with `site` already resolved, the way the middleware in `index.ts` leaves it. */
async function beacon(
  body: unknown,
  options: {
    /** `null` stands for "no site resolved" — the middleware sets that, it does not throw. */
    site?: { id: string; domain: string | null; timezone: string } | null
    headers?: Record<string, string>
  } = {},
) {
  const app = new Hono<AppEnv>()
  const site =
    options.site === undefined
      ? { id: 'site_a', domain: 'example.com', timezone: 'UTC' }
      : options.site

  app.use('*', async (c, next) => {
    c.set('site', site as never)
    await next()
  })
  app.route('/collect', collect)

  return await app.request(
    '/collect',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER, ...options.headers },
    },
    { PUBLIC_URL: 'https://cms.example.com', AUTH_SECRET: 'secret' },
  )
}

beforeEach(() => {
  recorded = []
})

describe('POST /collect', () => {
  test('records a view for the resolved site', async () => {
    const response = await beacon({ path: '/blog/hello', event: 'view' })

    expect(response.status).toBe(204)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ siteId: 'site_a', path: '/blog/hello', event: 'view' })
  })

  test('attributes the row to the site the request resolved to, never to one it names', async () => {
    // A beacon cannot carry a site id of its own: the site comes from the middleware, and the
    // record is written against that. A body claiming otherwise changes nothing.
    await beacon({ path: '/x', event: 'view', siteId: 'site_b', site: 'site_b' })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.siteId).toBe('site_a')
  })

  test('writes nothing when the reader has sent Do Not Track', async () => {
    const response = await beacon({ path: '/blog/hello' }, { headers: { dnt: '1' } })

    expect(response.status).toBe(204)
    expect(recorded).toHaveLength(0)
  })

  test('writes nothing for Global Privacy Control', async () => {
    await beacon({ path: '/blog/hello' }, { headers: { 'sec-gpc': '1' } })
    expect(recorded).toHaveLength(0)
  })

  test('writes nothing for a crawler', async () => {
    await beacon({ path: '/blog/hello' }, { headers: { 'user-agent': 'Googlebot/2.1' } })
    expect(recorded).toHaveLength(0)
  })

  test('writes nothing when no site resolved, and still answers 204', async () => {
    const response = await beacon({ path: '/blog/hello' }, { site: null })

    expect(response.status).toBe(204)
    expect(recorded).toHaveLength(0)
  })

  test('a malformed body is a 204 and a dropped count, never an error a website can see', async () => {
    const response = await beacon({ nothing: 'useful' })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(recorded).toHaveLength(0)
  })

  test("a referrer from the site's own domain is not recorded as a referral", async () => {
    // Otherwise the biggest source of traffic on every site would be the site itself.
    await beacon({
      path: '/blog/hello',
      event: 'view',
      referrer: 'https://www.example.com/blog',
    })

    expect(recorded[0]?.referrer).toBeNull()
  })

  test('an external referrer arrives as a bare host', async () => {
    await beacon({ path: '/', event: 'view', referrer: 'https://www.google.com/search?q=hedge' })

    expect(recorded[0]?.referrer).toBe('google.com')
  })
})

describe('GET /collect/script.js', () => {
  test('serves a script pointed at this deployment, cacheable and dependency-free', async () => {
    const app = new Hono<AppEnv>()
    app.route('/collect', collect)

    const response = await app.request(
      '/collect/script.js',
      {},
      {
        PUBLIC_URL: 'https://cms.example.com',
      },
    )
    const body = await response.text()

    expect(response.headers.get('content-type')).toContain('application/javascript')
    expect(response.headers.get('cache-control')).toContain('max-age')
    expect(body).toContain('https://cms.example.com/api/v1/collect')
    // The two properties that keep it out of a consent banner.
    expect(body).not.toContain('document.cookie')
    expect(body).not.toContain('localStorage')
    // And the reason it exists at all: no platform reports share counts, so the website's own
    // click handler is the only place share intent is observable.
    expect(body).toContain('window.hedge')
  })

  // #104: `sendBeacon` always sends credentials mode `include`, so an `application/json` body is
  // promoted to a preflighted CORS request and refused against this endpoint's wildcard
  // `Access-Control-Allow-Origin`. Nothing reports it server-side — the request never arrives — so
  // the collector simply recorded nothing. A safelisted type keeps it in no-cors mode.
  test('posts the beacon with a CORS-safelisted content type', async () => {
    const app = new Hono<AppEnv>()
    app.route('/collect', collect)

    const body = await (
      await app.request('/collect/script.js', {}, { PUBLIC_URL: 'https://cms.example.com' })
    ).text()

    expect(body).toContain("type: 'text/plain'")
    expect(body).not.toContain('application/json')
  })
})
