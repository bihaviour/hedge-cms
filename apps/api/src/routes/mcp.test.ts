import { describe, expect, mock, test } from 'bun:test'

// The route's DB-backed dependencies are mocked so the test exercises the HTTP + JSON-RPC wiring,
// the OAuth challenge, and the per-tool authorisation — not D1. The collection service itself is
// covered through the REST route it shares.

/** The OAuth access token the request presents, or `null` for an unauthenticated caller. */
let token: { userId: string; scopes: string } | null = {
  userId: 'usr_1',
  scopes: 'openid collections:read collections:write',
}

/** The signed-in user's role on the current site. `null` means they cannot reach it at all. */
let siteRole: string | null = 'admin'

const created: unknown[] = []
const deleted: string[] = []

mock.module('../lib/site', () => ({
  requireSite: () => ({ id: 'site_1', slug: 'blog' }),
}))

mock.module('../auth/cms', () => ({
  getCmsAuth: () => ({ api: { getMcpSession: async () => token } }),
}))

mock.module('../lib/auth', () => ({
  userRole: async () => (token ? 'admin' : null),
  currentSiteRole: async () => siteRole,
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

const env = { PUBLIC_URL: 'https://cms.example.com' }

async function rpc(body: unknown): Promise<{ status: number; json: RpcJson; res: Response }> {
  const res = await app.request(
    '/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: JSON.stringify(body),
    },
    env,
  )
  return { status: res.status, json: res.status === 202 ? null : await res.json(), res }
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

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
    const { json } = await call(3, 'list_collections')
    expect(json.result.structuredContent).toHaveLength(1)
    expect(json.result.isError).toBeUndefined()
  })

  test('create_collection with the write scope succeeds', async () => {
    const { json } = await call(4, 'create_collection', { slug: 'authors', name: 'Authors' })
    expect(json.result.isError).toBeUndefined()
    expect(created).toContainEqual({ slug: 'authors', name: 'Authors', kind: 'multiple' })
  })

  test('create_collection is refused when the client was not granted the write scope', async () => {
    token = { userId: 'usr_1', scopes: 'openid collections:read' }
    const { json } = await call(5, 'create_collection', { slug: 'x', name: 'X' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('collections:write')
    token = { userId: 'usr_1', scopes: 'openid collections:read collections:write' }
  })

  /** The scope is what was delegated; the role is what the user actually has. Both have to pass. */
  test('create_collection is refused when the user is not a site admin', async () => {
    siteRole = 'editor'
    const { json } = await call(6, 'create_collection', { slug: 'y', name: 'Y' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('admin')
    siteRole = 'admin'
  })

  test('invalid arguments fail the call with a helpful message', async () => {
    const { json } = await call(7, 'create_collection', { slug: 'Not A Slug', name: 'X' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('slug')
  })

  test('delete_collection removes it', async () => {
    const { json } = await call(8, 'delete_collection', { slug: 'posts' })
    expect(json.result.isError).toBeUndefined()
    expect(deleted).toContain('posts')
  })

  test('a lone notification gets a 202 with no body', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(status).toBe(202)
    expect(json).toBeNull()
  })

  /**
   * The challenge is how a client with nothing but a URL finds its way to a token, so its shape
   * matters as much as the 401 itself.
   */
  test('without a token, answers 401 and points at the resource metadata', async () => {
    token = null
    const { status, res, json } = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' })

    expect(status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://cms.example.com/.well-known/oauth-protected-resource"',
    )
    expect(json.error.code).toBe(-32000)
    token = { userId: 'usr_1', scopes: 'openid collections:read collections:write' }
  })

  test('a token for someone with no access to the site is refused', async () => {
    siteRole = null
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' })

    expect(status).toBe(403)
    expect(json.error.message).toContain('blog')
    siteRole = 'admin'
  })

  test('GET is not allowed', async () => {
    const res = await app.request('/', { method: 'GET' }, env)
    expect(res.status).toBe(405)
  })
})
