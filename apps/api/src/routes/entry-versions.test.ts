import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import type { SiteRow } from '../db/schema'
import type { Actor, AppEnv } from '../env'
import { errorResponse } from '../lib/errors'

/**
 * What the version routes accept as a credential.
 *
 * `/api/v1/collections` is in `KEY_MANAGED_PREFIXES`, so a write-scoped API key resolves on every
 * route in this file — which is right for authoring and wrong for approving. That distinction is
 * carried by `requireUserActor` on the three decision routes rather than by the prefix list, so it
 * is worth a test: an authoring key that can create a version must be refused when it approves one.
 *
 * The real `requireUserActor` runs here. Only the two middlewares that would need a database — the
 * site-role and scope checks — and the service itself are stubbed.
 */

const actualAuth = await import('../lib/auth')

mock.module('../lib/auth', () => ({
  ...actualAuth,
  requireSitePermission: () => async (_c: unknown, next: () => Promise<void>) => await next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => await next(),
  approvalLevelFor: async () => 2,
}))

const version = { id: 'ver_1', title: 'Added the interview section', status: 'in_review' }

mock.module('../lib/entry-versions', () => ({
  listEntryVersions: async () => [version],
  getEntryVersion: async () => version,
  createEntryVersion: async () => version,
  updateEntryVersion: async () => version,
  discardEntryVersion: async () => version,
  submitEntryVersion: async () => version,
  decideEntryVersion: async () => ({ ...version, status: 'approved' }),
  publishEntryVersion: async () => ({ version, entry: {} }),
}))

const { default: versions } = await import('./entry-versions')

/** A session actor and an authoring key, presented the way the credential middleware would set them. */
const session: Actor = {
  kind: 'user',
  via: 'session',
  id: 'usr_1',
  role: 'editor',
  permissions: [],
  scopes: [],
  siteId: null,
}

const apiKey: Actor = {
  kind: 'api_key',
  via: 'api_key',
  id: 'key_1',
  role: 'editor',
  permissions: [],
  scopes: ['content:read', 'content:write'],
  siteId: 'site_1',
}

function appAs(actor: Actor) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('actor', actor)
    // Set on the context rather than by stubbing `lib/site`, which is process-wide and would decide
    // how every other suite resolves a tenant.
    c.set('site', { id: 'site_1', slug: 'blog', defaultLocale: 'en', locales: ['en'] } as SiteRow)
    await next()
  })
  app.route('/collections/:collection/entries/:slug/versions', versions)
  app.onError((err, c) => errorResponse(c, err))
  return app
}

const post = (actor: Actor, path: string, body: unknown = {}) =>
  appAs(actor).request(`/collections/posts/entries/hello/versions${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('version routes and the credential they accept', () => {
  test('an authoring key may create a version', async () => {
    const res = await post(apiKey, '', { title: 'Added the interview section' })
    expect(res.status).toBe(201)
  })

  test('an authoring key may submit one for review', async () => {
    const res = await post(apiKey, '/ver_1/submit')
    expect(res.status).toBe(200)
  })

  test.each(['/ver_1/approve', '/ver_1/reject', '/ver_1/publish'])(
    'an authoring key is refused at %s',
    async (path) => {
      const res = await post(apiKey, path)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        error: { message: 'This endpoint requires a signed-in user' },
      })
    },
  )

  test.each(['/ver_1/approve', '/ver_1/reject', '/ver_1/publish'])(
    'a signed-in person is allowed at %s',
    async (path) => {
      const res = await post(session, path)
      expect(res.status).toBe(200)
    },
  )
})
