import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { collections, entries, type SiteRow, sites } from '../db/schema'
import type { Actor, AppEnv } from '../env'
import { errorResponse } from '../lib/errors'

/**
 * What the delivery API serves when a post has no version in the language that was asked for.
 *
 * Against a real SQLite, because the fallback is a SQL predicate — a correlated pick of one variant
 * per post — and the whole question is which row that predicate lands on. Stubbing the database out
 * would leave nothing to test.
 *
 * The rule being pinned: **a reader is never shown a hole.** A published post appears in an
 * Indonesian listing whether or not it has been translated yet, in the site's own language when it
 * has not, and every payload says which language it actually is so a caller can tell the difference.
 */

let db: ReturnType<typeof drizzle>

// Keeps every export the real module has: `mock.module` is process-wide and outlives this file,
// so one dropped here is an import error in whichever file runs next.
const realClient = await import('../db/client')
mock.module('../db/client', () => ({ ...realClient, getDb: () => db }))

const site: SiteRow = {
  id: 'site_1',
  slug: 'blog',
  name: 'Blog',
  description: null,
  domain: null,
  allowMemberSignup: true,
  locales: ['en', 'id', 'fr'],
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

const { default: content } = await import('./content')
const { resolveSite } = await import('../lib/site')

/**
 * The credential a public website holds, presented the way the middleware in `index.ts` sets it —
 * so the delivery API's own `requireSitePermission` and `requireScope` run for real.
 *
 * `lib/auth`, `lib/site` and `lib/preview` used to be replaced with stubs here. `mock.module` is
 * process-wide and outlives this file, so those stubs decided how *other* suites resolved a site
 * and checked a role — see the same warning in `lib/delivery-auth.test.ts`. Nothing is stubbed now
 * but the database.
 */
const deliveryKey: Actor = {
  kind: 'api_key',
  via: 'api_key',
  id: 'key_1',
  role: 'viewer',
  permissions: [],
  scopes: ['content:read'],
  siteId: 'site_1',
}

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

/**
 * Three pieces in different states of translation, which is the situation the fallback exists for:
 * one translated, one only in the site's language, one only in a language that is not the site's.
 */
const ROWS = [
  ['ent_1', 'tgr_a', 'hello-world', 'en', 'published', 'Hello world'],
  ['ent_2', 'tgr_a', 'halo-dunia', 'id', 'published', 'Halo dunia'],
  ['ent_3', 'tgr_b', 'second-post', 'en', 'published', 'Second post'],
  ['ent_4', 'tgr_b', 'kedua', 'id', 'draft', 'Kedua'],
  ['ent_5', 'tgr_c', 'bonjour', 'fr', 'published', 'Bonjour'],
] as const

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

  for (const [id, group, slug, locale, status, title] of ROWS) {
    await db.insert(entries).values({
      id,
      collectionId: 'col_articles',
      translationGroupId: group,
      slug,
      locale,
      status,
      visibility: 'public',
      data: { title },
      metadata: null,
      publishedAt: status === 'published' ? '2026-01-01T00:00:00.000Z' : null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  }
}

const app = new Hono<AppEnv>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  c.set('actor', deliveryKey)
  c.set('member', null)
  // Previewing is a separate path with its own tests (`lib/preview.test.ts`); every request here is
  // an ordinary public read, which is what an unset preview means.
  c.set('preview', null)
  await next()
})
app.use('*', resolveSite)
app.route('/', content)

const env = { PUBLIC_URL: 'https://cms.example.com' } as never

interface Item {
  slug: string
  locale: string
  localeFallback: boolean
  alternates?: { locale: string; slug: string }[]
}

const list = async (query: string) => {
  const res = await app.request(`/articles${query}`, {}, env)
  return { status: res.status, body: (await res.json()) as { data: Item[] } }
}

const one = async (path: string) => {
  const res = await app.request(`/articles/${path}`, {}, env)
  return { status: res.status, body: (await res.json()) as { data: Item } }
}

describe('delivery listing with a locale fallback', () => {
  beforeEach(seed)

  test('an untranslated site still lists every published piece', async () => {
    const { body } = await list('?locale=id')
    const served = Object.fromEntries(body.data.map((item) => [item.slug, item.locale]))

    // One row per piece, never one per translation: three pieces, three rows.
    expect(body.data).toHaveLength(3)
    expect(served['halo-dunia']).toBe('id')
    // No Indonesian version, so the site's own language rather than a gap in the listing.
    expect(served['second-post']).toBe('en')
    // Not in the site's language either — still shown, in the one language it has.
    expect(served.bonjour).toBe('fr')
  })

  test('each item says whether it is the language that was asked for', async () => {
    const { body } = await list('?locale=id')
    const byLocale = Object.fromEntries(body.data.map((item) => [item.slug, item.localeFallback]))

    expect(byLocale['halo-dunia']).toBe(false)
    expect(byLocale['second-post']).toBe(true)
    expect(byLocale.bonjour).toBe(true)
  })

  /**
   * The published-only filter has to run *inside* the pick as well as outside it. A draft
   * Indonesian version must not win the pick and then be filtered away — that would drop the piece
   * from the listing entirely rather than falling back to its published English one.
   */
  test('a draft translation does not hide the published one', async () => {
    const { body } = await list('?locale=id')
    const second = body.data.find((item) => item.slug === 'second-post')

    expect(second?.locale).toBe('en')
    expect(body.data.some((item) => item.slug === 'kedua')).toBe(false)
  })

  test('naming no locale serves the site default', async () => {
    const { body } = await list('')
    const served = body.data.map((item) => item.locale).sort()
    expect(served).toEqual(['en', 'en', 'fr'])
  })
})

describe('delivery single entry with a locale fallback', () => {
  beforeEach(seed)

  test('a slug in one language can be read in another', async () => {
    const { body } = await one('hello-world?locale=id')

    // Addressed by the English URL, answered with the Indonesian version — and with *its* slug, so
    // a client rendering a link points at the right page.
    expect(body.data.locale).toBe('id')
    expect(body.data.slug).toBe('halo-dunia')
    expect(body.data.localeFallback).toBe(false)
  })

  test('a piece with no version in the requested language falls back to the default', async () => {
    const { body } = await one('second-post?locale=fr')

    expect(body.data.locale).toBe('en')
    expect(body.data.localeFallback).toBe(true)
  })

  /**
   * A slug that belongs to exactly one language *is* a request for that language. Serving the site
   * default here would answer an Indonesian URL with English text.
   */
  test('a slug in one language only is served in that language', async () => {
    const { body } = await one('halo-dunia')

    expect(body.data.locale).toBe('id')
    expect(body.data.localeFallback).toBe(false)
  })

  test('the published languages come along, for hreflang', async () => {
    const { body } = await one('hello-world')

    expect(body.data.alternates).toEqual([
      { locale: 'en', slug: 'hello-world' },
      { locale: 'id', slug: 'halo-dunia' },
    ])
  })

  test('a draft translation is not offered as an alternate', async () => {
    const { body } = await one('second-post')

    expect(body.data.alternates).toEqual([{ locale: 'en', slug: 'second-post' }])
  })

  test('an unknown slug is still a 404', async () => {
    expect((await one('nothing-here')).status).toBe(404)
  })

  test('a piece with nothing published is a 404, not a draft', async () => {
    await db.delete(entries).where(undefined)
    await db.insert(entries).values({
      id: 'ent_9',
      collectionId: 'col_articles',
      translationGroupId: 'tgr_d',
      slug: 'unpublished',
      locale: 'en',
      status: 'draft',
      visibility: 'public',
      data: { title: 'Unpublished' },
      metadata: null,
      publishedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect((await one('unpublished')).status).toBe(404)
  })
})
