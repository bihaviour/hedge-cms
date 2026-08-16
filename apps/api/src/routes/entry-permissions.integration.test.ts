import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { roles, type SiteRow, siteUsers } from '../db/schema'
import type { Actor, AppEnv } from '../env'

/**
 * The case the epic exists for, against the real entry routes (#154).
 *
 * A role that may create, read and update an entry and **not** delete one was not expressible
 * before: both verbs were `requireSiteRole('editor')`, so the only way to withhold the delete was
 * to withhold the write with it. Here it is a row.
 *
 * The gates and the router are real — only the service beneath them is stubbed, because what is
 * being tested is which caller gets through, not what happens after.
 */

let db: ReturnType<typeof drizzle>

const realClient = await import('../db/client')
mock.module('../db/client', () => ({ ...realClient, getDb: () => db }))

const entry = { id: 'ent_1', slug: 'hello-world', title: 'Hello world' }
let deleted = 0

// Spread the real module: the entry-versions router hangs off this one and imports helpers from
// `lib/entries` that nothing here overrides, and a partial stub would break its import instead.
const realEntries = await import('../lib/entries')

mock.module('../lib/entries', () => ({
  ...realEntries,
  listEntries: async () => ({ data: [entry] }),
  getEntry: async () => entry,
  createEntry: async () => entry,
  updateEntry: async () => entry,
  deleteEntry: async () => {
    deleted += 1
  },
  listEntryRevisions: async () => [],
  restoreEntryRevision: async () => entry,
  listTranslations: async () => [],
  attachTranslation: async () => entry,
  detachTranslation: async () => entry,
}))

const { default: entries } = await import('./entries')
const { errorResponse } = await import('../lib/errors')

const MIGRATIONS = join(import.meta.dir, '../../migrations')

function migrate(sqlite: Database) {
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(join(MIGRATIONS, name), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
}

const person: Actor = {
  kind: 'user',
  via: 'session',
  id: 'usr_1',
  role: 'editor',
  permissions: [],
  scopes: [],
  siteId: null,
}

function server() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('actor', person)
    c.set('site', { id: 'site_1', slug: 'blog' } as SiteRow)
    await next()
  })
  app.route('/collections/:collection/entries', entries)
  app.onError((err, c) => errorResponse(c, err))
  return app
}

/** A role that writes but does not delete — the shape that had no expression before this epic. */
async function assign(sitePermissions: string[]) {
  await db.insert(roles).values({
    id: 'rol_author',
    slug: 'author',
    name: 'Author',
    sitePermissions,
    mcpPermissions: sitePermissions,
    apiKeyPermissions: sitePermissions,
  })
  await db.insert(siteUsers).values({ siteId: 'site_1', userId: 'usr_1', role: 'author' })
}

beforeEach(() => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite)
  deleted = 0
})

const env = {} as AppEnv['Bindings']

describe('a role that writes but cannot delete', () => {
  beforeEach(async () => {
    await assign(['entries:read', 'entries:create', 'entries:update'])
  })

  test('reads', async () => {
    const res = await server().request('/collections/posts/entries', {}, env)
    expect(res.status).toBe(200)
  })

  test('creates', async () => {
    const res = await server().request(
      '/collections/posts/entries',
      { method: 'POST', body: JSON.stringify({ slug: 'hello-world', data: {} }) },
      env,
    )
    expect(res.status).toBe(201)
  })

  test('updates', async () => {
    const res = await server().request(
      '/collections/posts/entries/hello-world',
      { method: 'PATCH', body: JSON.stringify({ data: {} }) },
      env,
    )
    expect(res.status).toBe(200)
  })

  test('and is refused the delete, by name', async () => {
    const res = await server().request(
      '/collections/posts/entries/hello-world',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { message: 'Requires "entries:delete" on the "blog" site' },
    })
    // The refusal is the gate, not the service reporting one — nothing reached `deleteEntry`.
    expect(deleted).toBe(0)
  })
})

describe('the same role with the delete added', () => {
  test('deletes', async () => {
    await assign(['entries:read', 'entries:create', 'entries:update', 'entries:delete'])

    const res = await server().request(
      '/collections/posts/entries/hello-world',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(deleted).toBe(1)
  })
})

describe('a role granting nothing', () => {
  test('reaches the site and may do nothing in it', async () => {
    // Distinct from having no grant at all, which is "you do not have access to this site". A role
    // can legitimately be empty, and the message has to say which of the two happened.
    await assign([])

    const res = await server().request('/collections/posts/entries', {}, env)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { message: 'Requires "entries:read" on the "blog" site' },
    })
  })
})
