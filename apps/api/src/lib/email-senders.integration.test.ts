import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { newsletters, sites } from '../db/schema'
import type { Bindings } from '../env'

/**
 * The sender address book (#136), against a real SQLite built from the committed migrations.
 *
 * What is pinned here is the tenancy boundary and the un-pointing on delete: a sender is scoped to
 * its site, an assignment cannot reach across tenants, and deleting an assigned sender must not
 * leave a site or a draft holding a dead id — which is what would make the Email tab claim an
 * assignment that no longer exists.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { assignSenders, createSender, deleteSender, listSenders, updateSender } = await import(
  './email-senders'
)

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

const env = {} as unknown as Bindings

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })

  await db.insert(sites).values([
    { id: 'site_1', slug: 'blog', name: 'Blog' },
    { id: 'site_2', slug: 'docs', name: 'Docs' },
  ])
})

describe('sender CRUD', () => {
  test('an address is unique per site, but two sites may each hold it', async () => {
    await createSender(env, 'site_1', { email: 'news@example.com', name: 'Blog' })
    await expect(createSender(env, 'site_1', { email: 'news@example.com' })).rejects.toThrow()

    // A second site is a different tenant, so the same address is allowed there.
    const other = await createSender(env, 'site_2', { email: 'news@example.com' })
    expect(other.email).toBe('news@example.com')
  })

  test('a listing is scoped to its site', async () => {
    await createSender(env, 'site_1', { email: 'a@example.com' })
    await createSender(env, 'site_2', { email: 'b@example.com' })
    const list = await listSenders(env, 'site_1')
    expect(list.map((s) => s.email)).toEqual(['a@example.com'])
  })

  test('updating another site’s sender is a 404, not a silent cross-tenant edit', async () => {
    const s = await createSender(env, 'site_1', { email: 'a@example.com' })
    await expect(updateSender(env, 'site_2', s.id, { name: 'Nope' })).rejects.toThrow()
  })
})

describe('assignment', () => {
  test('assigns member and newsletter independently, and refuses a cross-tenant id', async () => {
    const member = await createSender(env, 'site_1', { email: 'members@example.com' })
    const news = await createSender(env, 'site_1', { email: 'news@example.com' })
    const foreign = await createSender(env, 'site_2', { email: 'x@example.com' })

    const site = await assignSenders(env, 'site_1', {
      memberSenderId: member.id,
      newsletterSenderId: news.id,
    })
    expect(site.memberSenderId).toBe(member.id)
    expect(site.newsletterSenderId).toBe(news.id)

    await expect(
      assignSenders(env, 'site_1', { memberSenderId: foreign.id, newsletterSenderId: null }),
    ).rejects.toThrow()
  })

  test('null clears an assignment back to the CMS sender', async () => {
    const member = await createSender(env, 'site_1', { email: 'members@example.com' })
    await assignSenders(env, 'site_1', { memberSenderId: member.id, newsletterSenderId: null })
    const site = await assignSenders(env, 'site_1', {
      memberSenderId: null,
      newsletterSenderId: null,
    })
    expect(site.memberSenderId).toBeNull()
  })
})

describe('delete un-points everything that named the sender', () => {
  test('a deleted sender is cleared from the site assignment and any draft campaign', async () => {
    const news = await createSender(env, 'site_1', { email: 'news@example.com' })
    await assignSenders(env, 'site_1', { memberSenderId: null, newsletterSenderId: news.id })
    await db
      .insert(newsletters)
      .values({ id: 'news_1', siteId: 'site_1', subject: 'Hi', body: 'x', senderId: news.id })

    await deleteSender(env, 'site_1', news.id)

    const [site] = await db.select().from(sites).where(eq(sites.id, 'site_1'))
    expect(site?.newsletterSenderId).toBeNull()
    const [draft] = await db.select().from(newsletters).where(eq(newsletters.id, 'news_1'))
    expect(draft?.senderId).toBeNull()
  })
})
