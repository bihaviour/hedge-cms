import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CreateEntryInput } from '@hedge/core'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import {
  collections,
  entries,
  entryRevisions,
  entryVersionApprovals,
  entryVersions,
  type SiteRow,
  sites,
} from '../db/schema'

/**
 * Deleting a collection, against a real SQLite built from the committed migrations.
 *
 * The claim worth pinning is the one `deleteCollection` states in a comment and does not implement:
 * the entries go too, *via the foreign key*. Nothing in the function deletes them, so the only
 * thing standing between "delete a collection" and a table full of rows pointing at a collection
 * that no longer exists is `ON DELETE CASCADE` surviving in the generated migration. A schema edit
 * that dropped it would leave every test that mocks the database perfectly green.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { deleteCollection } = await import('./collections')
const { createEntry } = await import('./entries')

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
  previewUrl: null,
  previewEmbed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const otherSite: SiteRow = { ...site, id: 'site_2', slug: 'docs', name: 'Docs' }

const env = {} as never

async function seed() {
  const sqlite = new Database(':memory:')
  // D1 enforces foreign keys; bun:sqlite does not unless asked. Without this the cascade below
  // would silently not happen and the test would be measuring the wrong database.
  sqlite.exec('PRAGMA foreign_keys = ON')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })

  await db.insert(sites).values([site, otherSite])
  await db.insert(collections).values([
    {
      id: 'col_articles',
      siteId: site.id,
      slug: 'articles',
      name: 'Articles',
      kind: 'multiple',
      fields: [{ kind: 'text', name: 'title', label: 'Title' }],
      approvalLevels: 0,
    },
    {
      id: 'col_notes',
      siteId: site.id,
      slug: 'notes',
      name: 'Notes',
      kind: 'multiple',
      fields: [{ kind: 'text', name: 'title', label: 'Title' }],
      approvalLevels: 0,
    },
    // Same slug, different tenant — deleting one must not reach the other.
    {
      id: 'col_articles_docs',
      siteId: otherSite.id,
      slug: 'articles',
      name: 'Articles',
      kind: 'multiple',
      fields: [{ kind: 'text', name: 'title', label: 'Title' }],
      approvalLevels: 0,
    },
  ])
}

const draft = (title: string): CreateEntryInput => ({
  status: 'draft',
  visibility: 'public',
  data: { title },
})

describe('deleteCollection', () => {
  beforeEach(seed)

  test('removes the collection', async () => {
    await deleteCollection(env, site.id, 'articles')

    const rows = await db.select().from(collections).where(eq(collections.siteId, site.id))
    expect(rows.map((row) => row.slug)).toEqual(['notes'])
  })

  test('takes its entries and their revisions with it', async () => {
    const entry = await createEntry(env, site, 'articles', draft('A piece'), null)
    await db.insert(entryRevisions).values({
      id: 'rev_1',
      entryId: entry.id,
      data: entry.data,
      status: entry.status,
    })
    await db.insert(entryVersions).values({
      id: 'ver_1',
      siteId: site.id,
      entryId: entry.id,
      title: 'A proposed change',
      data: entry.data,
      status: 'draft',
      baseUpdatedAt: entry.updatedAt,
    })
    // Two hops from the collection: it cascades through the version, not from the entry.
    await db.insert(entryVersionApprovals).values({
      id: 'vap_1',
      versionId: 'ver_1',
      level: 1,
      decision: 'approved',
    })

    await deleteCollection(env, site.id, 'articles')

    expect(await db.select().from(entries)).toEqual([])
    expect(await db.select().from(entryRevisions)).toEqual([])
    expect(await db.select().from(entryVersions)).toEqual([])
    expect(await db.select().from(entryVersionApprovals)).toEqual([])
  })

  test('leaves another collection on the same site alone', async () => {
    const kept = await createEntry(env, site, 'notes', draft('A note'), null)
    await createEntry(env, site, 'articles', draft('A piece'), null)

    await deleteCollection(env, site.id, 'articles')

    const remaining = await db.select().from(entries)
    expect(remaining.map((row) => row.id)).toEqual([kept.id])
  })

  test('is scoped to one tenant — the same slug on another site survives', async () => {
    await deleteCollection(env, site.id, 'articles')

    const rows = await db.select().from(collections).where(eq(collections.siteId, otherSite.id))
    expect(rows.map((row) => row.slug)).toEqual(['articles'])
  })

  test('a slug that belongs to another site is not found, not deleted', async () => {
    // `docs` has no `notes` collection; the one that exists belongs to `blog`.
    expect(deleteCollection(env, otherSite.id, 'notes')).rejects.toThrow(/not found/i)

    const rows = await db.select().from(collections).where(eq(collections.siteId, site.id))
    expect(rows.map((row) => row.slug).sort()).toEqual(['articles', 'notes'])
  })

  test('an unknown slug is not found', async () => {
    expect(deleteCollection(env, site.id, 'nope')).rejects.toThrow(/not found/i)
  })
})
