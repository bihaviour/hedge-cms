import { describe, expect, test } from 'bun:test'
import { ANALYTICS_COLLECT_PATH, ANALYTICS_SCRIPT_PATH } from '@hedge/core'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { AppEnv } from '../env'
import { securityHeaders } from './security-headers'

// What is pinned here is a header whose absence is invisible: under `same-origin` a website's
// `<img>` fetches the file, gets a 200 of the right type, and renders nothing — no 404, no CSP
// violation, no console error. Nothing but this test notices.

const app = new Hono<AppEnv>()
app.use('*', securityHeaders)
app.get('*', (c) => c.body('ok'))

const corp = async (path: string) =>
  (await app.request(path)).headers.get('cross-origin-resource-policy')

describe('securityHeaders', () => {
  test('lets another origin embed a media object', async () => {
    expect(await corp('/media/blog/2026/07/k1a2b3-photo.png')).toBe('cross-origin')
  })

  test('keeps every other response same-origin', async () => {
    expect(await corp('/api/v1/content/posts')).toBe('same-origin')
    expect(await corp('/')).toBe('same-origin')
  })

  // #104: the same silent failure as the media one, on a `<script src>` instead of an `<img>`. Under
  // `same-origin` the embedding site fetched the beacon, got a 200 of the right type, and discarded
  // it unexecuted — `window.hedge` undefined, no error anywhere, and every dashboard reading zero.
  test('lets another origin execute the analytics beacon', async () => {
    expect(await corp(ANALYTICS_SCRIPT_PATH)).toBe('cross-origin')
  })

  // The tempting over-fix for #104 is to widen the whole `/api/v1/collect` prefix. CORP does apply
  // to the collector — `sendBeacon` posts in no-cors mode — but only to a `204` nothing reads, and
  // the event is recorded before the browser refuses it, so the write lands either way. Widening it
  // would loosen the only unauthenticated write endpoint here for no gain. Exact paths, not a
  // prefix, so a route added under `/collect/` later has to be named to be widened.
  test('does not widen the collector or the rest of its prefix', async () => {
    expect(await corp(ANALYTICS_COLLECT_PATH)).toBe('same-origin')
    expect(await corp(`${ANALYTICS_COLLECT_PATH}/anything-else`)).toBe('same-origin')
  })

  test('does not widen the media management routes', async () => {
    // `/api/v1/media` lists and uploads; only the `/media/*` passthrough serves bytes to a website.
    expect(await corp('/api/v1/media')).toBe('same-origin')
    expect(await corp('/api/v1/media/med_123')).toBe('same-origin')
  })

  test('still sets the rest of the defaults on a media response', async () => {
    const res = await app.request('/media/photo.png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  // The reason this is one path-aware middleware rather than a second one scoped to `/media/*`:
  // `secureHeaders` writes on the way back out, so an outer instance overwrites an inner one and
  // the narrower mount silently does nothing. If Hono ever stops doing that, the design is still
  // correct — but the comment explaining it would be wrong, so it is pinned.
  test('an inner secureHeaders would be overwritten by an outer one', async () => {
    const nested = new Hono()
    nested.use('*', secureHeaders())
    nested.use('/media/*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }))
    nested.get('*', (c) => c.body('ok'))

    const res = await nested.request('/media/photo.png')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  })
})
