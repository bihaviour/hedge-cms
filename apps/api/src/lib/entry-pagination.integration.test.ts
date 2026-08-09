import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CreateEntryInput, ListEntriesQuery } from '@hedge/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { collections, type SiteRow, sites } from '../db/schema'

/**
 * `total` on a page of entries (#123), against a real SQLite built from the committed migrations.
 *
 * What makes this worth a test rather than an eyeball: the count and the page are two queries over
 * two *different* filter sets — the page carries the cursor, the count must not — and getting that
 * wrong produces a number that looks entirely plausible. A count that inherited the cursor would
 * read "of 5" on the last page of a hundred rows, which nobody would file as a bug so much as
 * distrust quietly.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { createEntry, listEntries } = await import('./entries')

const MIGRATIONS = join(import.meta.dir, '../../migrations')

function migrate(sqlite: Database) {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
}

const site: SiteRow = {
  id: 'site_1',
  slug: 'blog',
  name: 'Blog',
  description: null,
  domain: null,
  allowMemberSignup: true,
  locales: ['en'],
  defaultLocale: 'en',
  timezone: 'UTC',
  metadata: null,
  customFields: null,
  emailFrom: null,
  emailFromName: null,
  emailReplyTo: null,
  newsletterFrom: null,
  newsletterFromName: null,
  newsletterReplyTo: null,
  previewUrl: null,
  previewEmbed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const env = {} as never

async function seed() {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })

  await db.insert(sites).values(site)
  await db.insert(collections).values({
    id: 'col_articles',
    siteId: site.id,
    slug: 'articles',
    name: 'Articles',
    kind: 'multiple',
    fields: [{ kind: 'text', name: 'title', label: 'Title' }],
    approvalLevels: 0,
  })
}

/** The route applies the schema's defaults before the service sees the input. */
const create = (title: string, rest: Partial<CreateEntryInput> = {}) =>
  createEntry(
    env,
    site,
    'articles',
    { status: 'draft', visibility: 'public', data: { title }, ...rest } satisfies CreateEntryInput,
    null,
  )

/** `listEntries` takes a fully-defaulted query; these are the defaults the zod schema applies. */
const query = (over: Partial<ListEntriesQuery> = {}): ListEntriesQuery => ({
  groupBy: 'locale',
  limit: 20,
  sort: 'updatedAt',
  order: 'desc',
  ...over,
})

describe('total on a page of entries', () => {
  beforeEach(seed)

  test('counts the whole list, not the page', async () => {
    for (let i = 0; i < 7; i++) await create(`Entry ${i}`)

    const page = await listEntries(env, site, 'articles', query({ limit: 3 }))

    expect(page.data).toHaveLength(3)
    expect(page.nextCursor).toBeTruthy()
    expect(page.total).toBe(7)
  })

  /** The reason the cursor is kept off the count's filters. */
  test('the count does not shrink as the cursor advances', async () => {
    for (let i = 0; i < 7; i++) await create(`Entry ${i}`)

    const first = await listEntries(env, site, 'articles', query({ limit: 3 }))
    const second = await listEntries(
      env,
      site,
      'articles',
      query({ limit: 3, cursor: first.nextCursor ?? undefined }),
    )
    const third = await listEntries(
      env,
      site,
      'articles',
      query({ limit: 3, cursor: second.nextCursor ?? undefined }),
    )

    expect(second.total).toBe(7)
    expect(third.total).toBe(7)
    // The last page is short; the total is still the whole list.
    expect(third.data).toHaveLength(1)
    expect(third.nextCursor).toBeNull()
  })

  test('a filter narrows the count with the rows', async () => {
    await create('Published one', { status: 'published' })
    await create('Published two', { status: 'published' })
    await create('A draft')

    const published = await listEntries(env, site, 'articles', query({ status: 'published' }))
    const all = await listEntries(env, site, 'articles', query())

    expect(published.total).toBe(2)
    expect(all.total).toBe(3)
  })

  test('an empty collection counts zero rather than reporting nothing', async () => {
    const page = await listEntries(env, site, 'articles', query())

    expect(page.data).toEqual([])
    expect(page.total).toBe(0)
  })
})
