import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnalyticsRange } from '@hedge/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { analyticsDaily, collections, entries, type SiteRow, sites } from '../db/schema'

/**
 * `collectionEntryTotals`, against a real SQLite built from the committed migrations.
 *
 * It feeds the traffic columns on the entries table, and the two things worth pinning are both
 * things a mocked database cannot tell us: that the collection subquery actually narrows (an entry
 * of another collection, or another tenant, must not leak into a collection's numbers), and that an
 * entry seen only in the *previous* window still comes back — a piece whose traffic has stopped is
 * exactly the one an editor is looking for, and dropping it would report it as untracked.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { collectionEntryTotals } = await import('./analytics-report')

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

const site = {
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
  memberSenderId: null,
  newsletterSenderId: null,
  previewUrl: null,
  previewEmbed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies SiteRow

const otherSite: SiteRow = { ...site, id: 'site_2', slug: 'docs', name: 'Docs' }

/** February is the current window here; January is the one every total is compared against. */
const range: AnalyticsRange = {
  from: '2026-02-01',
  to: '2026-02-28',
  timezone: 'UTC',
  previous: { from: '2026-01-04', to: '2026-01-31' },
  firstDay: '2026-01-01',
}

const env = {} as never

const entryRow = (id: string, collectionId: string, slug: string) => ({
  id,
  collectionId,
  translationGroupId: `tg_${id}`,
  slug,
  status: 'published' as const,
  visibility: 'public' as const,
  locale: 'en',
  data: { title: slug },
  metadata: null,
  publishedAt: null,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const bucket = (
  id: string,
  row: {
    siteId?: string
    date: string
    entryId: string | null
    path: string
    metric: 'view' | 'share_intent' | 'referral'
    count: number
  },
) => ({ id, siteId: site.id, key: '', ...row })

async function seed() {
  const sqlite = new Database(':memory:')
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
  ])

  await db
    .insert(entries)
    .values([
      entryRow('ent_a', 'col_articles', 'a'),
      entryRow('ent_b', 'col_articles', 'b'),
      entryRow('ent_gone', 'col_articles', 'gone'),
      entryRow('ent_note', 'col_notes', 'note'),
    ])

  await db.insert(analyticsDaily).values([
    // `ent_a`: read across two days of the window, shared once, and read in the previous one too.
    bucket('anl_1', { date: '2026-02-03', entryId: 'ent_a', path: '/a', metric: 'view', count: 7 }),
    bucket('anl_2', { date: '2026-02-04', entryId: 'ent_a', path: '/a', metric: 'view', count: 5 }),
    bucket('anl_3', {
      date: '2026-02-04',
      entryId: 'ent_a',
      path: '/a',
      metric: 'share_intent',
      count: 2,
    }),
    bucket('anl_4', { date: '2026-01-10', entryId: 'ent_a', path: '/a', metric: 'view', count: 4 }),
    // `ent_gone`: read in the previous window only. Its traffic stopped; it still exists.
    bucket('anl_5', {
      date: '2026-01-12',
      entryId: 'ent_gone',
      path: '/gone',
      metric: 'view',
      count: 9,
    }),
    // A path that resolved to no entry at all, and a different collection's entry.
    bucket('anl_6', { date: '2026-02-05', entryId: null, path: '/', metric: 'view', count: 40 }),
    bucket('anl_7', {
      date: '2026-02-05',
      entryId: 'ent_note',
      path: '/note',
      metric: 'view',
      count: 11,
    }),
    // Another tenant, same shape. The window filter alone would let this through.
    bucket('anl_8', {
      siteId: otherSite.id,
      date: '2026-02-05',
      entryId: 'ent_b',
      path: '/b',
      metric: 'view',
      count: 99,
    }),
    // Outside the window on the far side, so the range bound is exercised in both directions.
    bucket('anl_9', { date: '2026-03-01', entryId: 'ent_b', path: '/b', metric: 'view', count: 3 }),
  ])
}

describe('collectionEntryTotals', () => {
  beforeEach(seed)

  test('sums a window per entry, with the previous window and share intents beside it', async () => {
    const rows = await collectionEntryTotals(env, site, range, 'col_articles')
    const a = rows.find((row) => row.entryId === 'ent_a')

    expect(a).toEqual({ entryId: 'ent_a', views: 12, previousViews: 4, shareIntents: 2 })
  })

  test('keeps an entry whose only traffic is in the previous window', async () => {
    const rows = await collectionEntryTotals(env, site, range, 'col_articles')

    // Reporting nothing for it would render as "untracked" beside a piece that was read 9 times
    // last month — which is the drop an editor scanning this column is looking for.
    expect(rows.find((row) => row.entryId === 'ent_gone')).toEqual({
      entryId: 'ent_gone',
      views: 0,
      previousViews: 9,
      shareIntents: 0,
    })
  })

  test('answers for one collection only, and one tenant only', async () => {
    const rows = await collectionEntryTotals(env, site, range, 'col_articles')

    // `ent_note` is another collection's; `ent_b`'s only in-window row belongs to another site;
    // the `/` bucket has no entry at all.
    expect(rows.map((row) => row.entryId).sort()).toEqual(['ent_a', 'ent_gone'])
  })

  test('leaves out an entry with no rollup in either window', async () => {
    const rows = await collectionEntryTotals(env, site, range, 'col_notes')

    expect(rows.map((row) => row.entryId)).toEqual(['ent_note'])
  })
})
