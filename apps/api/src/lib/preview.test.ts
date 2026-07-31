import { describe, expect, test } from 'bun:test'
import { PREVIEW_TOKEN_HEADER } from '@hedge/core'
import { Hono } from 'hono'
import type { Actor, AppEnv, Bindings } from '../env'
import { requireUserActor } from './auth'
import { ApiError } from './errors'
import { type PreviewClaims, previewFor, resolvePreview, signPreviewToken } from './preview'

// The point of these tests is the *scoping*: a preview token names one entry on one site, and every
// way of stretching it past that has to fail. No database is involved — the token is stateless, and
// verification is signature plus claims, which is exactly what is asserted here.

const env = { AUTH_SECRET: 'test-secret' } as Bindings

const CLAIMS: PreviewClaims = {
  siteId: 'site_a',
  collection: 'posts',
  slug: 'hello-world',
  locale: 'en',
  userId: 'usr_1',
  expiresAt: Math.floor(Date.now() / 1000) + 600,
}

/**
 * Runs `resolvePreview` with a site already resolved, then asks `previewFor` about one entry —
 * the same two steps a delivery request goes through.
 */
async function previewOn(
  siteId: string,
  token: string | null,
  entry: { collection: string; slug: string; locale: string } = {
    collection: 'posts',
    slug: 'hello-world',
    locale: 'en',
  },
): Promise<PreviewClaims | null> {
  const app = new Hono<AppEnv>()
  let seen: PreviewClaims | null = null

  app.use('*', async (c, next) => {
    c.set('site', { id: siteId } as never)
    await next()
  })
  app.use('*', resolvePreview)
  app.get('/', (c) => {
    seen = previewFor(c, entry.collection, entry.slug, entry.locale)
    return c.body(null, 204)
  })

  await app.request('/', { headers: token ? { [PREVIEW_TOKEN_HEADER]: token } : {} }, env)
  return seen
}

describe('preview tokens', () => {
  test('a freshly minted token unlocks the entry it names', async () => {
    const token = await signPreviewToken(env, CLAIMS)
    expect(await previewOn('site_a', token)).toMatchObject({
      siteId: 'site_a',
      collection: 'posts',
      slug: 'hello-world',
      locale: 'en',
      userId: 'usr_1',
    })
  })

  test('no token at all is not a preview', async () => {
    expect(await previewOn('site_a', null)).toBeNull()
  })

  /** The tenant boundary. A token is a statement about one site and cannot be replayed at another. */
  test('a token minted for site A does not resolve on site B', async () => {
    const token = await signPreviewToken(env, CLAIMS)
    expect(await previewOn('site_b', token)).toBeNull()
  })

  test('a token bound to one slug does not unlock its neighbour', async () => {
    const token = await signPreviewToken(env, CLAIMS)
    expect(
      await previewOn('site_a', token, {
        collection: 'posts',
        slug: 'another-post',
        locale: 'en',
      }),
    ).toBeNull()
  })

  test('nor the same slug in another collection', async () => {
    const token = await signPreviewToken(env, CLAIMS)
    expect(
      await previewOn('site_a', token, { collection: 'pages', slug: 'hello-world', locale: 'en' }),
    ).toBeNull()
  })

  /** Entries are keyed by locale too, so a token that ignored it would unlock every translation. */
  test('nor the same slug in another locale', async () => {
    const token = await signPreviewToken(env, CLAIMS)
    expect(
      await previewOn('site_a', token, { collection: 'posts', slug: 'hello-world', locale: 'id' }),
    ).toBeNull()
  })

  test('an expired token is refused', async () => {
    const token = await signPreviewToken(env, {
      ...CLAIMS,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    })
    expect(await previewOn('site_a', token)).toBeNull()
  })

  test('a tampered payload fails the signature comparison', async () => {
    const token = await signPreviewToken(env, CLAIMS)
    const [version, payload, signature] = token.split('.')
    // Re-encode the claims pointing at another entry, keeping the original signature.
    const forged = btoa(
      JSON.stringify({ s: 'site_a', c: 'posts', g: 'secret-draft', l: 'en', u: 'usr_1', e: 9e9 }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(await previewOn('site_a', `${version}.${forged}.${signature}`)).toBeNull()
    expect(await previewOn('site_a', `${version}.${payload}.${signature}x`)).toBeNull()
  })

  test('a token signed with another secret is refused', async () => {
    const token = await signPreviewToken({ AUTH_SECRET: 'other-secret' } as Bindings, CLAIMS)
    expect(await previewOn('site_a', token)).toBeNull()
  })

  test('a value that is not a hedge preview token is ignored rather than throwing', async () => {
    expect(await previewOn('site_a', 'not-a-token')).toBeNull()
    expect(await previewOn('site_a', 'hpv1.@@@.@@@')).toBeNull()
  })
})

/**
 * The gate on minting. `POST …/preview-token` lives under `KEY_MANAGED_PREFIXES`, so a write-scoped
 * API key resolves on that prefix — and the feature's whole requirement is that only a signed-in
 * CMS user can produce a link to unpublished content. This is the check that says so.
 */
describe('requireUserActor, the mint gate', () => {
  function contextWith(actor: Actor | null) {
    return { get: (key: string) => (key === 'actor' ? actor : undefined) } as never
  }

  const key: Actor = {
    kind: 'api_key',
    via: 'api_key',
    id: 'key_1',
    role: 'editor',
    permissions: [],
    scopes: ['content:write'],
    siteId: 'site_a',
  }

  test('refuses a write-scoped API key', () => {
    expect(() => requireUserActor(contextWith(key))).toThrow(ApiError)
  })

  test('refuses a delegated MCP client, whatever the approving user could do', () => {
    expect(() => requireUserActor(contextWith({ ...key, kind: 'user', via: 'oauth' }))).toThrow(
      ApiError,
    )
  })

  test('accepts a signed-in user', () => {
    const user: Actor = {
      kind: 'user',
      via: 'session',
      id: 'usr_1',
      role: 'viewer',
      permissions: [],
      scopes: [],
      siteId: null,
    }
    expect(requireUserActor(contextWith(user))).toBe(user)
  })
})
