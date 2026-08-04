import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CreateEntryInput } from '@hedge/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { collections, entries, type SiteRow, sites } from '../db/schema'

/**
 * Posts with several language variants, against a real SQLite built from the committed
 * migrations — because every rule here is a rule about what is *in the table*: which rows share a
 * translation group, which slug already belongs to a post, which language a post already has.
 *
 * The thing being pinned is the shift from "translations are the same slug in another locale" to
 * "translations are rows sharing a group". The first made a URL in each language impossible; the
 * second is what `attachTranslation` can repair after the fact.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const {
  attachTranslation,
  createEntry,
  deleteEntry,
  detachTranslation,
  listEntries,
  listTranslations,
  updateEntry,
} = await import('./entries')

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
  locales: ['en', 'id', 'fr'],
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

const create = (title: string, rest: Partial<CreateEntryInput> = {}) =>
  createEntry(env, site, 'articles', draft({ title }, rest), null)

describe('a post and its language variants', () => {
  beforeEach(seed)

  test('an entry with no siblings is a post of its own', async () => {
    const first = await create('First')
    const second = await create('Second')

    expect(first.translationGroupId).toBeTruthy()
    expect(second.translationGroupId).not.toBe(first.translationGroupId)
  })

  /**
   * The whole point of the group column. Before it, saying "these are one piece" meant giving them
   * one slug, so a localised URL was not expressible at all.
   */
  test('a translation can have a slug in its own language', async () => {
    const english = await create('Hello world')
    const indonesian = await create('Halo dunia', {
      slug: 'halo-dunia',
      locale: 'id',
      translationOf: english.slug,
    })

    expect(english.slug).toBe('hello-world')
    expect(indonesian.slug).toBe('halo-dunia')
    expect(indonesian.translationGroupId).toBe(english.translationGroupId)
    // Same piece, so the same identifier — which the old slug-keyed lookup could not have found.
    expect(indonesian.data.code).toBe(english.data.code)
  })

  /** How every translation was created before `translationOf` existed. It has to keep working. */
  test('sharing a slug still joins the post, with no translationOf', async () => {
    const english = await create('Hello world')
    const indonesian = await create('Halo dunia', { slug: english.slug, locale: 'id' })

    expect(indonesian.translationGroupId).toBe(english.translationGroupId)
  })

  test('a post holds one variant per language', async () => {
    const english = await create('Hello world')
    await create('Halo dunia', { slug: 'halo-dunia', locale: 'id', translationOf: english.slug })

    await expect(
      create('Halo lagi', { slug: 'halo-lagi', locale: 'id', translationOf: english.slug }),
    ).rejects.toThrow(/already has a "id" version/)
  })

  /**
   * Reusing a slug in the *same* language is refused as a duplicate language rather than a slug
   * clash, and that ordering is deliberate: the slug fallback reads it as "another version of that
   * piece" first — which is what it has always meant — and the post already has one in English.
   */
  test('reusing a slug in a language the post already has is refused', async () => {
    await create('Hello world')
    await expect(create('Something else', { slug: 'hello-world' })).rejects.toThrow(
      /already has a "en" version/,
    )
  })

  /**
   * A slug has to name exactly one post, or the delivery API's fallback would have two posts to
   * fall back within and no way to choose between them.
   */
  test('a slug cannot be taken by a second post', async () => {
    await create('Hello world')
    const second = await create('Second')

    await expect(
      create('Halo', { slug: 'hello-world', locale: 'id', translationOf: second.slug }),
    ).rejects.toThrow(/already belongs to another entry/)
  })

  test('a rename cannot take another post’s slug', async () => {
    await create('Hello world')
    const other = await create('Second')

    await expect(
      updateEntry(env, site, 'articles', other.slug, { slug: 'hello-world' }, null),
    ).rejects.toThrow(/already belongs to another entry/)
  })

  test('listTranslations answers for a language the post does not have yet', async () => {
    const english = await create('Hello world')
    await create('Halo dunia', { slug: 'halo-dunia', locale: 'id', translationOf: english.slug })

    // Addressed by the English slug while there is no French variant at all — the case the editor's
    // locale switcher asks in, and the one a (slug, locale) lookup would 404 on.
    const languages = await listTranslations(env, site, 'articles', english.slug)
    expect(languages.map((one) => one.locale).sort()).toEqual(['en', 'id'])
    expect(languages.find((one) => one.locale === 'id')?.slug).toBe('halo-dunia')
  })
})

describe('merging separately-authored translations', () => {
  beforeEach(seed)

  test('linking makes two posts one, keeping both slugs', async () => {
    const english = await create('Hello world')
    const indonesian = await create('Halo dunia', { slug: 'halo-dunia', locale: 'id' })
    expect(indonesian.translationGroupId).not.toBe(english.translationGroupId)

    const languages = await attachTranslation(env, site, 'articles', english.slug, {
      slug: indonesian.slug,
    })

    expect(languages.map((one) => one.locale).sort()).toEqual(['en', 'id'])
    // A merge changes what the rows belong to, never what they say: no URL moves.
    expect(languages.map((one) => one.slug).sort()).toEqual(['halo-dunia', 'hello-world'])
  })

  test('the merged post keeps one code', async () => {
    const english = await create('Hello world')
    const indonesian = await create('Halo dunia', { slug: 'halo-dunia', locale: 'id' })
    expect(indonesian.data.code).not.toBe(english.data.code)

    await attachTranslation(env, site, 'articles', english.slug, { slug: indonesian.slug })

    const merged = await listTranslations(env, site, 'articles', english.slug)
    const rows = await db.select().from(entries)
    const codes = new Set(rows.map((row) => row.data.code))
    expect(merged).toHaveLength(2)
    expect([...codes]).toEqual([english.data.code])
  })

  test('linking brings every language the other post already had', async () => {
    const english = await create('Hello world')
    const indonesian = await create('Halo dunia', { slug: 'halo-dunia', locale: 'id' })
    await create('Bonjour', {
      slug: 'bonjour',
      locale: 'fr',
      translationOf: indonesian.slug,
    })

    const languages = await attachTranslation(env, site, 'articles', english.slug, {
      slug: indonesian.slug,
    })

    // Not just the row that was named — the French one would otherwise be stranded in a post whose
    // other language had walked away.
    expect(languages.map((one) => one.locale).sort()).toEqual(['en', 'fr', 'id'])
  })

  test('two posts that both have a language cannot be merged', async () => {
    const english = await create('Hello world')
    const other = await create('Another piece', { slug: 'another-piece' })

    await expect(
      attachTranslation(env, site, 'articles', english.slug, { slug: other.slug }),
    ).rejects.toThrow(/Both entries already have a "en" version/)
  })

  test('linking twice is not an error', async () => {
    const english = await create('Hello world')
    const indonesian = await create('Halo dunia', { slug: 'halo-dunia', locale: 'id' })

    await attachTranslation(env, site, 'articles', english.slug, { slug: indonesian.slug })
    const again = await attachTranslation(env, site, 'articles', english.slug, {
      slug: indonesian.slug,
    })

    expect(again.map((one) => one.locale).sort()).toEqual(['en', 'id'])
  })

  test('unlinking splits a language back out, keeping its code', async () => {
    const english = await create('Hello world')
    const indonesian = await create('Halo dunia', {
      slug: 'halo-dunia',
      locale: 'id',
      translationOf: english.slug,
    })

    const split = await detachTranslation(env, site, 'articles', indonesian.slug, 'id')

    expect(split.translationGroupId).not.toBe(english.translationGroupId)
    // A code is assigned once and never moves — an identifier that changed when somebody corrected
    // a link would be worse than two pieces sharing one.
    expect(split.data.code).toBe(english.data.code)
    expect(await listTranslations(env, site, 'articles', english.slug)).toHaveLength(1)
  })
})

describe('listing posts rather than rows', () => {
  beforeEach(seed)

  test('groupBy=post returns one row per piece, in the site default language', async () => {
    const english = await create('Hello world')
    await create('Halo dunia', { slug: 'halo-dunia', locale: 'id', translationOf: english.slug })
    await create('Second')

    const grouped = await listEntries(env, site, 'articles', {
      groupBy: 'post',
      limit: 20,
      sort: 'updatedAt',
      order: 'desc',
    })

    expect(grouped.data).toHaveLength(2)
    expect(grouped.data.every((entry) => entry.locale === 'en')).toBe(true)
    // Each carries its languages, so the list can show them without a query per row.
    const hello = grouped.data.find((entry) => entry.slug === 'hello-world')
    expect(hello?.translations?.map((one) => one.locale).sort()).toEqual(['en', 'id'])
  })

  test('the default is still a row per translation', async () => {
    const english = await create('Hello world')
    await create('Halo dunia', { slug: 'halo-dunia', locale: 'id', translationOf: english.slug })

    const rows = await listEntries(env, site, 'articles', {
      groupBy: 'locale',
      limit: 20,
      sort: 'updatedAt',
      order: 'desc',
    })

    expect(rows.data).toHaveLength(2)
    expect(rows.data[0]?.translations).toBeUndefined()
  })

  /** A post with no variant in the site's default language must still appear exactly once. */
  test('a piece written only in another language is represented by that one', async () => {
    const indonesian = await create('Halo dunia', { slug: 'halo-dunia', locale: 'id' })
    await create('Bonjour', { slug: 'bonjour', locale: 'fr', translationOf: indonesian.slug })

    const grouped = await listEntries(env, site, 'articles', {
      groupBy: 'post',
      limit: 20,
      sort: 'updatedAt',
      order: 'desc',
    })

    expect(grouped.data).toHaveLength(1)
    expect(['id', 'fr']).toContain(grouped.data[0]!.locale)
  })

  test('deleting one language leaves the rest of the post alone', async () => {
    const english = await create('Hello world')
    await create('Halo dunia', { slug: 'halo-dunia', locale: 'id', translationOf: english.slug })

    await deleteEntry(env, site, 'articles', 'halo-dunia', 'id')

    const languages = await listTranslations(env, site, 'articles', english.slug)
    expect(languages.map((one) => one.locale)).toEqual(['en'])
  })
})
