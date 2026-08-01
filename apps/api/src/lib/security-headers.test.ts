import { describe, expect, test } from 'bun:test'
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
