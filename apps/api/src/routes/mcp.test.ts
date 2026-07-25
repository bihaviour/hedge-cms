import { describe, expect, mock, test } from 'bun:test'
import type { Actor } from '../env'

// The route's DB-backed dependencies are mocked so the test exercises the HTTP + JSON-RPC wiring
// and the per-tool authorisation, not D1. The collection service itself is covered through the
// REST route it shares.

// Mutated per test to flip the caller's identity and scopes.
let actor: Actor = {
  kind: 'api_key',
  id: 'key_1',
  role: 'editor',
  scopes: ['content:read', 'collections:write'],
  siteId: 'site_1',
}

const created: unknown[] = []
const deleted: string[] = []

mock.module('../lib/site', () => ({
  requireSite: () => ({ id: 'site_1', slug: 'blog' }),
}))

mock.module('../lib/auth', () => ({
  requireActor: () => actor,
  requireSiteRole: () => async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
  currentSiteRole: async () => 'admin',
}))

const collection = (slug: string) => ({
  id: `col_${slug}`,
  slug,
  name: slug,
  description: null,
  kind: 'multiple' as const,
  fields: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

mock.module('../lib/collections', () => ({
  listCollections: async () => [collection('posts')],
  getCollection: async (_e: unknown, _s: string, slug: string) => collection(slug),
  createCollection: async (_e: unknown, _s: string, input: { slug: string }) => {
    created.push(input)
    return collection(input.slug)
  },
  updateCollection: async (_e: unknown, _s: string, slug: string) => collection(slug),
  deleteCollection: async (_e: unknown, _s: string, slug: string) => {
    deleted.push(slug)
  },
}))

const { default: app } = await import('./mcp')

// biome-ignore lint/suspicious/noExplicitAny: test assertions reach into the JSON-RPC response
type RpcJson = any

async function rpc(body: unknown): Promise<{ status: number; json: RpcJson }> {
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: res.status === 202 ? null : await res.json() }
}

describe('POST /mcp', () => {
  test('initialize reports the collection server', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(json.result.serverInfo.name).toBe('hedge-collections')
  })

  test('tools/list advertises the five collection tools', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'list_collections',
      'get_collection',
      'create_collection',
      'update_collection',
      'delete_collection',
    ])
  })

  test('list_collections returns structured data', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_collections', arguments: {} },
    })
    expect(json.result.structuredContent).toHaveLength(1)
    expect(json.result.isError).toBeUndefined()
  })

  test('create_collection with the write scope succeeds', async () => {
    actor = { ...actor, scopes: ['content:read', 'collections:write'] }
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'create_collection', arguments: { slug: 'authors', name: 'Authors' } },
    })
    expect(json.result.isError).toBeUndefined()
    expect(created).toContainEqual({ slug: 'authors', name: 'Authors', kind: 'multiple' })
  })

  test('create_collection is refused without the collections:write scope', async () => {
    actor = { ...actor, scopes: ['content:read'] }
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_collection', arguments: { slug: 'x', name: 'X' } },
    })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('collections:write')
  })

  test('invalid arguments fail the call with a helpful message', async () => {
    actor = { ...actor, scopes: ['content:read', 'collections:write'] }
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'create_collection', arguments: { slug: 'Not A Slug', name: 'X' } },
    })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('slug')
  })

  test('delete_collection removes it', async () => {
    actor = { ...actor, scopes: ['content:read', 'collections:write'] }
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'delete_collection', arguments: { slug: 'posts' } },
    })
    expect(json.result.isError).toBeUndefined()
    expect(deleted).toContain('posts')
  })

  test('a lone notification gets a 202 with no body', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(status).toBe(202)
    expect(json).toBeNull()
  })

  test('GET is not allowed', async () => {
    const res = await app.request('/', { method: 'GET' })
    expect(res.status).toBe(405)
  })
})
