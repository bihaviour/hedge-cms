import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import type { Actor, AppEnv } from '../env'

// The point of these tests is the *boundary*, not the database: which credential resolves on which
// prefix, and what role a key acts with. D1 and Better Auth are mocked so the assertions are about
// the middleware alone.

/** The row `apiKeys` lookup returns, or nothing for an unknown key. */
let keyRow: { id: string; siteId: string; scopes: string[]; expiresAt: string | null } | null = null

/** Whether the session lookup finds a signed-in user. */
let session: { user: { id: string; role: string } } | null = null

const select = () => ({
  from: () => ({ where: () => ({ limit: async () => (keyRow ? [keyRow] : []) }) }),
})

// `mock.module` is process-wide and outlives this file, so the replacement has to keep every export
// the real module has — anything dropped here becomes an import error in whichever test file runs
// next. Spread the original rather than listing what this file happens to use.
const realClient = await import('../db/client')

mock.module('../db/client', () => ({
  ...realClient,
  getDb: () => ({
    select,
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }),
}))

// `lib/crypto` is deliberately not mocked. Bun has real Web Crypto, the lookup below ignores the
// `where` clause anyway, and stubbing it broke an unrelated suite that needs its other exports.

const realCmsAuth = await import('../auth/cms')
mock.module('../auth/cms', () => ({
  ...realCmsAuth,
  getCmsAuth: () => ({ api: { getSession: async () => session } }),
}))

const { resolveDeliveryActor, resolveSessionOrKeyActor } = await import('./delivery-auth')

/** Runs one middleware and reports the actor it set. */
async function actorFrom(
  middleware: typeof resolveDeliveryActor,
  headers: Record<string, string> = {},
): Promise<Actor | null> {
  const app = new Hono<AppEnv>()
  let seen: Actor | null = null

  app.use('*', middleware)
  app.get('/', (c) => {
    seen = c.get('actor')
    return c.body(null, 204)
  })

  await app.request(
    '/',
    { headers },
    { AUTH_SECRET: 'secret' },
    // `waitUntil` is used for best-effort usage tracking; swallow it.
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  )
  return seen
}

const withKey = (headers: Record<string, string> = {}) => ({
  authorization: 'Bearer hdg_abcdefghijkl',
  ...headers,
})

beforeEach(() => {
  keyRow = { id: 'key_1', siteId: 'site_1', scopes: ['content:read'], expiresAt: null }
  session = null
})

describe('resolveDeliveryActor', () => {
  test('resolves any key, including a read-only one', async () => {
    const actor = await actorFrom(resolveDeliveryActor, withKey())
    expect(actor).toMatchObject({ kind: 'api_key', via: 'api_key', role: 'viewer' })
  })

  test('a write scope raises the key to editor', async () => {
    keyRow!.scopes = ['content:read', 'content:write']
    expect((await actorFrom(resolveDeliveryActor, withKey()))?.role).toBe('editor')
  })

  test('collections:write raises it to admin, because schema routes require one', async () => {
    keyRow!.scopes = ['collections:write']
    expect((await actorFrom(resolveDeliveryActor, withKey()))?.role).toBe('admin')
  })

  test('members:session raises it to admin, because minting a reader’s session is one', async () => {
    keyRow!.scopes = ['members:session']
    expect((await actorFrom(resolveDeliveryActor, withKey()))?.role).toBe('admin')
  })

  test('an expired key resolves to nothing', async () => {
    keyRow!.expiresAt = '2020-01-01T00:00:00.000Z'
    expect(await actorFrom(resolveDeliveryActor, withKey())).toBeNull()
  })

  test('an unknown key resolves to nothing', async () => {
    keyRow = null
    expect(await actorFrom(resolveDeliveryActor, withKey())).toBeNull()
  })

  test('a bearer token that is not a hedge key is ignored', async () => {
    expect(await actorFrom(resolveDeliveryActor, { authorization: 'Bearer ey.jwt' })).toBeNull()
  })

  test('a session cookie is never consulted on the delivery API', async () => {
    session = { user: { id: 'usr_1', role: 'owner' } }
    expect(await actorFrom(resolveDeliveryActor, {})).toBeNull()
  })
})

describe('resolveSessionOrKeyActor', () => {
  /**
   * The load-bearing case. A `content:read` key is what sits in a public website's environment;
   * letting it resolve here would hand it `GET /collections/:c/entries`, which — unlike the
   * delivery API — returns drafts.
   */
  test('refuses a key with no write scope, so a delivery key cannot read drafts', async () => {
    keyRow!.scopes = ['content:read']
    expect(await actorFrom(resolveSessionOrKeyActor, withKey())).toBeNull()
  })

  test('resolves a key that carries a write scope', async () => {
    keyRow!.scopes = ['content:read', 'content:write']
    expect(await actorFrom(resolveSessionOrKeyActor, withKey())).toMatchObject({
      kind: 'api_key',
      role: 'editor',
      siteId: 'site_1',
    })
  })

  test('media:write alone is enough to be an authoring key', async () => {
    keyRow!.scopes = ['media:write']
    expect((await actorFrom(resolveSessionOrKeyActor, withKey()))?.role).toBe('editor')
  })

  /**
   * `members:session` writes nothing, so it is not a `:write` scope — but it is held by a site's own
   * backend rather than by its frontend, and the mint route lives on this tier. What the condition
   * excludes is the delivery credential above, not every key that does not author.
   */
  test('members:session alone resolves here, as a site’s own backend', async () => {
    keyRow!.scopes = ['members:session']
    expect(await actorFrom(resolveSessionOrKeyActor, withKey())).toMatchObject({
      kind: 'api_key',
      role: 'admin',
      siteId: 'site_1',
    })
  })

  test('falls back to the session when no key is presented', async () => {
    session = { user: { id: 'usr_1', role: 'editor' } }
    expect(await actorFrom(resolveSessionOrKeyActor, {})).toMatchObject({
      kind: 'user',
      via: 'session',
      id: 'usr_1',
    })
  })

  /** A presented key is the caller's stated intent — do not silently fall back to their cookie. */
  test('does not fall back to a session when an unusable key was presented', async () => {
    keyRow!.scopes = ['content:read']
    session = { user: { id: 'usr_1', role: 'owner' } }
    expect(await actorFrom(resolveSessionOrKeyActor, withKey())).toBeNull()
  })

  test('resolves nothing when neither credential is present', async () => {
    expect(await actorFrom(resolveSessionOrKeyActor, {})).toBeNull()
  })
})
