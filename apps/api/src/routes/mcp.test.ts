import { describe, expect, mock, test } from 'bun:test'

// The route's DB-backed dependencies are mocked so the test exercises the HTTP + JSON-RPC wiring,
// the OAuth challenge, and the per-tool authorisation — not D1. The services themselves are covered
// through the REST routes they share.

/** The OAuth access token the request presents, or `null` for an unauthenticated caller. */
const ALL_SCOPES =
  'openid collections:read collections:write entries:read entries:write media:read media:write ' +
  'newsletters:read newsletters:write sites:read sites:write users:read users:write keys:read keys:write'

let token: { userId: string; scopes: string } | null = { userId: 'usr_1', scopes: ALL_SCOPES }

/** The signed-in user's role on the current site. `null` means they cannot reach it at all. */
let siteRole: string | null = 'admin'
/** Their instance role — `users.role`. What separates user management from site work. */
let instanceRole: string | null = 'admin'

const created: unknown[] = []
const deleted: string[] = []
const invited: unknown[] = []

mock.module('../lib/site', () => ({
  requireSite: () => ({ id: 'site_1', slug: 'blog', defaultLocale: 'en', locales: ['en'] }),
}))

mock.module('../auth/cms', () => ({
  getCmsAuth: () => ({ api: { getMcpSession: async () => token } }),
}))

mock.module('../lib/auth', () => ({
  userRole: async () => (token ? instanceRole : null),
  currentSiteRole: async () => siteRole,
  siteRoleFor: async () => siteRole,
  accessibleSites: async () => [{ id: 'site_1', slug: 'blog' }],
  generateApiKey: async () => ({ raw: 'hdg_secret', row: {} }),
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

const entry = (slug: string, status = 'draft') => ({
  id: `ent_${slug}`,
  collectionId: 'col_posts',
  collectionSlug: 'posts',
  slug,
  status,
  visibility: 'public',
  locale: 'en',
  data: { title: slug },
  metadata: { noIndex: false, custom: {} },
  publishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

mock.module('../lib/entries', () => ({
  listEntries: async () => ({ data: [entry('hello')], nextCursor: null }),
  getEntry: async (_e: unknown, _s: unknown, _c: string, slug: string) => entry(slug),
  createEntry: async (_e: unknown, _s: unknown, _c: string, input: { slug?: string }) => {
    created.push(input)
    return entry(input.slug ?? 'generated', input.slug ? 'draft' : 'draft')
  },
  updateEntry: async (_e: unknown, _s: unknown, _c: string, slug: string) => entry(slug),
  deleteEntry: async (_e: unknown, _s: unknown, _c: string, slug: string) => {
    deleted.push(slug)
  },
  listEntryRevisions: async () => [],
  restoreEntryRevision: async (_e: unknown, _s: unknown, _c: string, slug: string) => entry(slug),
  listTranslations: async () => [{ locale: 'en', slug: 'hello', status: 'published' }],
  attachTranslation: async () => [{ locale: 'en', slug: 'hello', status: 'published' }],
  detachTranslation: async (_e: unknown, _s: unknown, _c: string, slug: string) => entry(slug),
}))

mock.module('../lib/api-keys', () => ({
  listApiKeys: async () => [
    { id: 'key_1', name: 'delivery', prefix: 'hdg_ab', scopes: ['content:read'] },
  ],
  createApiKey: async () => ({ id: 'key_2', name: 'authoring', scopes: ['content:write'] }),
  deleteApiKey: async () => {},
}))

// Only the one read is stubbed; the rest of the module is kept as it is, since a mock that drops
// an export the tool module imports fails the import itself rather than the call.
const newsletterLib = await import('../lib/newsletter')

mock.module('../lib/newsletter', () => ({
  ...newsletterLib,
  listNewsletterTemplates: async () => [{ id: 'tpl_1', name: 'Weekly', subject: 'Hello' }],
}))

const version = (id: string, status = 'draft') => ({
  id,
  entryId: 'ent_hello',
  collectionSlug: 'posts',
  entrySlug: 'hello',
  locale: 'en',
  title: 'Added the interview section',
  data: { title: 'Hello' },
  metadata: null,
  status,
  baseUpdatedAt: '2026-01-01T00:00:00Z',
  stale: false,
  createdBy: 'usr_1',
  createdByName: 'A',
  submittedAt: null,
  publishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  approvals: [],
  requiredLevels: 2,
})

mock.module('../lib/entry-versions', () => ({
  listEntryVersions: async () => [version('ver_1')],
  createEntryVersion: async () => version('ver_2'),
  submitEntryVersion: async () => version('ver_2', 'in_review'),
}))

mock.module('../lib/users', () => ({
  listUsers: async () => [
    {
      id: 'usr_1',
      email: 'a@example.com',
      name: 'A',
      role: 'admin',
      createdAt: '',
      pending: false,
    },
  ],
  listUserSites: async () => [],
  inviteUser: async (_e: unknown, input: { email: string }) => {
    invited.push(input)
    return {
      id: 'usr_2',
      email: input.email,
      name: 'B',
      role: 'editor',
      createdAt: '',
      pending: true,
    }
  },
  updateUser: async () => ({
    id: 'usr_2',
    email: 'b@example.com',
    name: 'B',
    role: 'admin',
    createdAt: '',
    pending: false,
  }),
  deleteUser: async () => {},
  setUserSiteRole: async () => ({ siteId: 'site_1', userId: 'usr_2', role: 'editor' }),
  removeUserSiteRole: async () => {},
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

let nextId = 1
const call = (name: string, args: Record<string, unknown> = {}) =>
  rpc({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })

const listTools = async (): Promise<string[]> => {
  const { json } = await rpc({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' })
  return json.result.tools.map((t: { name: string }) => t.name)
}

/** Restores the default full-access caller, so one test's narrowing cannot leak into the next. */
function reset() {
  token = { userId: 'usr_1', scopes: ALL_SCOPES }
  siteRole = 'admin'
  instanceRole = 'admin'
}

describe('POST /mcp', () => {
  test('initialize reports the server', async () => {
    reset()
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(json.result.serverInfo.name).toBe('hedge')
  })

  test('tools/list covers every area of the CMS', async () => {
    reset()
    const names = await listTools()
    // Content model, content, media, email, deployment.
    expect(names).toContain('create_collection')
    expect(names).toContain('create_entry')
    expect(names).toContain('update_media')
    expect(names).toContain('create_newsletter_template')
    expect(names).toContain('create_newsletter')
    expect(names).toContain('add_subscriber')
    expect(names).toContain('create_site')
    expect(names).toContain('invite_user')
    expect(names).toContain('create_api_key')
  })

  /**
   * The bulk send is the one REST power deliberately withheld: it reaches real inboxes and cannot
   * be recalled. Its absence is a decision, so it is pinned.
   */
  test('no tool sends a newsletter to its audience', async () => {
    reset()
    const names = await listTools()
    expect(names).toContain('send_test_newsletter')
    expect(names).not.toContain('send_newsletter')
  })

  /**
   * Versions are the second withholding, and a sharper one: an agent approving the version it has
   * just written is not review, it is a rubber stamp with extra steps. Authoring and submitting are
   * exposed; blessing and publishing are decisions only a signed-in person can make.
   */
  test('no tool approves, rejects or publishes an entry version', async () => {
    reset()
    const names = await listTools()
    expect(names).toContain('create_entry_version')
    expect(names).toContain('submit_entry_version')
    expect(names).toContain('list_entry_versions')
    expect(names).not.toContain('approve_entry_version')
    expect(names).not.toContain('reject_entry_version')
    expect(names).not.toContain('publish_entry_version')
  })

  test('every tool name is unique', async () => {
    reset()
    const names = await listTools()
    expect(new Set(names).size).toBe(names.length)
  })

  /* ---------------------------------------------------------------- *
   * The result envelope
   * ---------------------------------------------------------------- */

  /**
   * `structuredContent` is a JSON **object** in the MCP spec, and a conforming client enforces it:
   * a bare array is rejected before the model sees any of the response, so a tool returning one is
   * not degraded but unusable (#114). Every list therefore answers `{ data }` — the same shape the
   * paginated tools already return, minus `nextCursor`, so a client holding a list never has to ask
   * which list it is. `ToolResult.structured` makes the wrong shape a compile error; this pins the
   * wire result, which is what the client actually validates.
   */
  test('every list tool returns a record, never a bare array', async () => {
    reset()
    const lists: [string, Record<string, unknown>][] = [
      ['list_collections', {}],
      ['list_sites', {}],
      ['list_users', {}],
      ['list_user_sites', { userId: 'usr_1' }],
      ['list_api_keys', {}],
      ['list_newsletter_templates', {}],
      ['list_entries', { collection: 'posts' }],
      ['list_entry_revisions', { collection: 'posts', slug: 'hello' }],
      ['list_entry_versions', { collection: 'posts', slug: 'hello' }],
      ['list_translations', { collection: 'posts', slug: 'hello' }],
    ]

    for (const [name, args] of lists) {
      const { json } = await call(name, args)
      const structured = json.result.structuredContent
      expect(json.result.isError).toBeUndefined()
      expect(Array.isArray(structured)).toBe(false)
      expect(Array.isArray(structured.data)).toBe(true)
    }
  })

  /** The one write that answers with a list — a merge returns the post's languages. */
  test('link_translation answers with a record too', async () => {
    reset()
    const { json } = await call('link_translation', {
      collection: 'posts',
      slug: 'hello',
      linkSlug: 'halo-dunia',
    })
    expect(json.result.isError).toBeUndefined()
    expect(Array.isArray(json.result.structuredContent)).toBe(false)
    expect(Array.isArray(json.result.structuredContent.data)).toBe(true)
  })

  /* ---------------------------------------------------------------- *
   * Scope — what the operator delegated to this client
   * ---------------------------------------------------------------- */

  /**
   * A token issued before the surface grew carries only the collection scopes. It must still see
   * exactly the tools it saw then, and nothing it was never approved for.
   */
  test('a collections-only token sees only the five collection tools', async () => {
    reset()
    token = { userId: 'usr_1', scopes: 'openid collections:read collections:write' }
    expect(await listTools()).toEqual([
      'list_collections',
      'get_collection',
      'create_collection',
      'update_collection',
      'delete_collection',
    ])
  })

  test('tools/list hides what the client was not granted', async () => {
    reset()
    token = { userId: 'usr_1', scopes: 'openid entries:read' }
    const names = await listTools()
    expect(names).toEqual([
      'list_entries',
      'get_entry',
      'list_entry_revisions',
      'list_translations',
      'list_entry_versions',
    ])
    expect(names).not.toContain('create_entry')
    // Reading which languages a post has is `entries:read`; changing them is not.
    expect(names).not.toContain('link_translation')
  })

  test('a tool outside the granted scopes is refused when called by name', async () => {
    reset()
    token = { userId: 'usr_1', scopes: 'openid collections:read' }
    const { json } = await call('create_collection', { slug: 'x', name: 'X' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('collections:write')
  })

  /* ---------------------------------------------------------------- *
   * Role — what the approving user actually holds
   * ---------------------------------------------------------------- */

  /** The scope is what was delegated; the role is what the user has. Both have to pass. */
  test('create_collection is refused when the user is not a site admin', async () => {
    reset()
    siteRole = 'editor'
    const { json } = await call('create_collection', { slug: 'y', name: 'Y' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('admin')
  })

  /** Drafting a post is an editor's job, so the same role that fails above succeeds here. */
  test('an editor can draft an entry with the same token', async () => {
    reset()
    siteRole = 'editor'
    const { json } = await call('create_entry', {
      collection: 'posts',
      slug: 'my-post',
      data: { title: 'My post' },
    })
    expect(json.result.isError).toBeUndefined()
    expect(json.result.structuredContent.slug).toBe('my-post')
  })

  test('a viewer can read entries but not write them', async () => {
    reset()
    siteRole = 'viewer'
    const read = await call('list_entries', { collection: 'posts' })
    expect(read.json.result.isError).toBeUndefined()

    const write = await call('create_entry', { collection: 'posts', data: { title: 'No' } })
    expect(write.json.result.isError).toBe(true)
    expect(write.json.result.content[0].text).toContain('editor')
  })

  /**
   * User management is gated on the *instance* role, not the site one — a site admin managing
   * deployment access would be a site admin minting deployment access.
   */
  test('a site admin who is only an instance editor cannot manage users', async () => {
    reset()
    siteRole = 'admin'
    instanceRole = 'editor'
    const { json } = await call('list_users')
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('deployment')
  })

  test('an instance admin can invite a user', async () => {
    reset()
    const { json } = await call('invite_user', { email: 'new@example.com', name: 'New' })
    expect(json.result.isError).toBeUndefined()
    expect(invited).toContainEqual({ email: 'new@example.com', name: 'New', role: 'editor' })
  })

  /** Deleting a site needs `sites:delete`, which the built-in admin role lacks — so an admin is
   *  refused where they pass everything else. */
  test('delete_site is refused for an instance admin', async () => {
    reset()
    const { json } = await call('delete_site', { slug: 'blog' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('sites:delete')
  })

  /**
   * An owner needs no special case in the authorisation code — the built-in owner role carries
   * every instance permission and `sites:access_all` resolves them to site admin everywhere. This
   * is what pins that.
   */
  test('an owner passes both role levels', async () => {
    reset()
    siteRole = 'owner'
    instanceRole = 'owner'

    for (const [name, args] of [
      ['create_collection', { slug: 'z', name: 'Z' }],
      ['create_entry', { collection: 'posts', slug: 'p', data: { title: 'P' } }],
      ['list_users', {}],
    ] as const) {
      const { json } = await call(name, args)
      expect(json.result.isError).toBeUndefined()
    }
  })

  /* ---------------------------------------------------------------- *
   * Arguments and transport
   * ---------------------------------------------------------------- */

  test('invalid arguments fail the call with a helpful message', async () => {
    reset()
    const { json } = await call('create_collection', { slug: 'Not A Slug', name: 'X' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('slug')
  })

  test('entry data is required, so a malformed create is caught before the service', async () => {
    reset()
    const { json } = await call('create_entry', { collection: 'posts' })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('data')
  })

  test('delete_collection removes it', async () => {
    reset()
    const { json } = await call('delete_collection', { slug: 'posts' })
    expect(json.result.isError).toBeUndefined()
    expect(deleted).toContain('posts')
  })

  test('a lone notification gets a 202 with no body', async () => {
    reset()
    const { status, json } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(status).toBe(202)
    expect(json).toBeNull()
  })

  /**
   * The challenge is how a client with nothing but a URL finds its way to a token, so its shape
   * matters as much as the 401 itself.
   */
  test('without a token, answers 401 and points at the resource metadata', async () => {
    reset()
    token = null
    const { status, res, json } = await rpc({ jsonrpc: '2.0', id: 99, method: 'tools/list' })

    expect(status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://cms.example.com/.well-known/oauth-protected-resource"',
    )
    expect(json.error.code).toBe(-32000)
  })

  test('a token for someone with no access to the site is refused', async () => {
    reset()
    siteRole = null
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 98, method: 'tools/list' })

    expect(status).toBe(403)
    expect(json.error.message).toContain('blog')
  })

  test('GET is not allowed', async () => {
    const res = await app.request('/', { method: 'GET' }, env)
    expect(res.status).toBe(405)
  })
})
