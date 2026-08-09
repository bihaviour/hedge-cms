import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CreateEntryInput } from '@hedge/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { collections, type SiteRow, sites } from '../db/schema'

/**
 * Generated `code` fields against a real SQLite built from the committed migrations, because every
 * rule about them is a rule about what is already *in the table* — the highest code issued, the
 * sibling translation to inherit from, the value the entry already carries.
 *
 * The four decisions pinned here are the ones a reader would otherwise have to take on trust: a
 * code is assigned on create, a client cannot set or change one, a translation shares its sibling's,
 * and the sequence keeps counting correctly once it outgrows its padding.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { createEntry, updateEntry } = await import('./entries')

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
  locales: ['en', 'id'],
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
  memberSenderId: null,
  newsletterSenderId: null,
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
    fields: [
      { kind: 'text', name: 'title', label: 'Title' },
      { kind: 'code', name: 'code', label: 'Code', prefix: 'RB-', padding: 4 },
    ],
    approvalLevels: 0,
  })
}

/** What the route hands the service: the schema's defaults are already applied by then. */
const draft = (data: Record<string, unknown>, rest: Partial<CreateEntryInput> = {}) =>
  ({ status: 'draft', visibility: 'public', data, ...rest }) satisfies CreateEntryInput

const create = (title: string, extra: Record<string, unknown> = {}) =>
  createEntry(env, site, 'articles', draft({ title, ...extra }), null)

describe('generated code fields', () => {
  beforeEach(seed)

  test('a new entry saved as a draft is assigned the next code', async () => {
    const first = await create('First piece')
    const second = await create('Second piece')

    expect(first.status).toBe('draft')
    expect(first.data.code).toBe('RB-0001')
    expect(second.data.code).toBe('RB-0002')
  })

  test('a code sent by a client is discarded, on create and on update alike', async () => {
    const created = await create('A piece', { code: 'RB-9999' })
    expect(created.data.code).toBe('RB-0001')

    const updated = await updateEntry(
      env,
      site,
      'articles',
      created.slug,
      { data: { title: 'A piece, revised', code: 'RB-9999' } },
      null,
    )
    expect(updated.data.code).toBe('RB-0001')
  })

  test('renaming the slug does not reissue the code', async () => {
    const created = await create('A piece')
    const renamed = await updateEntry(
      env,
      site,
      'articles',
      created.slug,
      { slug: 'a-different-slug', data: { title: 'A piece' } },
      null,
    )

    expect(renamed.slug).toBe('a-different-slug')
    expect(renamed.data.code).toBe(created.data.code)
  })

  test('a translation is the same piece, so it carries the same code', async () => {
    const english = await create('A piece')
    const indonesian = await createEntry(
      env,
      site,
      'articles',
      draft({ title: 'Sebuah tulisan' }, { slug: english.slug, locale: 'id' }),
      null,
    )

    expect(indonesian.locale).toBe('id')
    expect(indonesian.data.code).toBe(english.data.code)
  })

  test('an entry that predates the field being declared gets a code on its next write', async () => {
    await db.update(collections).set({
      fields: [{ kind: 'text', name: 'title', label: 'Title' }],
    })
    const before = await create('Older piece')
    expect(before.data.code).toBeUndefined()

    await db.update(collections).set({
      fields: [
        { kind: 'text', name: 'title', label: 'Title' },
        { kind: 'code', name: 'code', label: 'Code', prefix: 'RB-', padding: 4 },
      ],
    })
    const after = await updateEntry(
      env,
      site,
      'articles',
      before.slug,
      { data: { title: 'Older piece' } },
      null,
    )

    expect(after.data.code).toBe('RB-0001')
  })

  /**
   * The sequence is read back out of the stored strings, so once the count passes the padding a
   * plain lexicographic `max` would answer `RB-9999` forever and every later piece would collide.
   */
  test('the sequence keeps counting after it outgrows the padding', async () => {
    const created = await create('The nine-thousandth')
    // Rewrite the stored code directly: reaching 9999 through the API would mean 9999 inserts.
    await db.run(
      `update entries set data = json_set(data, '$.code', 'RB-9999') where slug = '${created.slug}'`,
    )

    const next = await create('The one after')
    expect(next.data.code).toBe('RB-10000')

    await db.run(
      `update entries set data = json_set(data, '$.code', 'RB-10000') where slug = '${next.slug}'`,
    )
    const after = await create('The one after that')
    expect(after.data.code).toBe('RB-10001')
  })
})
