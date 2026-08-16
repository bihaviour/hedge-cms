import { describe, expect, mock, test } from 'bun:test'
import { builtinSiteRole } from '@hedge/core'
import { Hono } from 'hono'
import type { SiteRow } from '../db/schema'
import type { Actor, AppEnv } from '../env'
import { errorResponse } from '../lib/errors'

/**
 * `GET /api/v1/access` — what the caller may do on the active site.
 *
 * The admin gates its site-admin controls on this answer, so the two things worth pinning are that
 * it reports the *site* role rather than the instance one, and that it is a person's route: a
 * machine has no UI to gate, and an API key resolving here would hand the delivery credential a
 * view of the deployment's authority model.
 *
 * The real `requireUserActor` runs. Only the site-role resolution and the site itself are stubbed,
 * since both need a database.
 */

const actualAuth = await import('../lib/auth')

let siteRole: 'admin' | 'editor' | 'viewer' = 'viewer'

mock.module('../lib/auth', () => ({
  ...actualAuth,
  currentSiteRole: async () => siteRole,
  currentSitePermissions: async () => builtinSiteRole(siteRole)?.site ?? [],
  approvalLevelFor: async (_env: unknown, actor: Actor) =>
    actor.kind === 'user' && actor.via === 'session' && siteRole === 'admin' ? 2 : 0,
}))

const { default: access } = await import('./access')

/** An instance editor, and an authoring key — presented the way the credential middleware sets them. */
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
  role: 'admin',
  permissions: [],
  scopes: ['collections:write'],
  siteId: 'site_1',
}

type AuthorityBody = { data: { role: string; approvalLevel: number; permissions: string[] } }

function get(actor: Actor) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('actor', actor)
    // The site the middleware in `index.ts` would have resolved. Set on the context rather than by
    // stubbing `lib/site`: `mock.module` is process-wide, and a stub of that module decides how
    // every *other* suite resolves a tenant.
    c.set('site', { id: 'site_1', slug: 'blog' } as SiteRow)
    await next()
  })
  app.route('/access', access)
  app.onError((err, c) => errorResponse(c, err))
  return app.request('/access')
}

describe('the caller’s authority on the active site', () => {
  test('reports the site role, not the instance one', async () => {
    siteRole = 'admin'
    const res = await get(session)

    expect(res.status).toBe(200)
    // `session` is an instance *editor* who holds admin on this site — the grant is what the admin
    // gates on, so a route reporting `users.role` here would hide controls the server would allow.
    expect((await res.json()) as AuthorityBody).toEqual({
      data: { role: 'admin', approvalLevel: 2, permissions: builtinSiteRole('admin')!.site },
    })
  })

  test('a site viewer gets no approval authority', async () => {
    siteRole = 'viewer'
    const res = await get(session)

    expect((await res.json()) as AuthorityBody).toEqual({
      data: { role: 'viewer', approvalLevel: 0, permissions: builtinSiteRole('viewer')!.site },
    })
  })

  test('carries the permission set, which is what a control gates on', async () => {
    // The slug is a name; two deployments can define `editor` differently, and #157's controls read
    // this list. A viewer's is the four reads — no `entries:create` anywhere in it.
    siteRole = 'viewer'
    const body = (await (await get(session)).json()) as AuthorityBody

    expect(body.data.permissions).toContain('entries:read')
    expect(body.data.permissions).not.toContain('entries:create')
  })

  test('an API key is refused', async () => {
    siteRole = 'admin'
    const res = await get(apiKey)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { message: 'This endpoint requires a signed-in user' },
    })
  })
})
