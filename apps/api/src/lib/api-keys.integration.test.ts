import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { apiKeys, type SiteRow, sites } from '../db/schema'
import type { Bindings } from '../env'

/**
 * Renaming and rotating a key, against a real SQLite built from the committed migrations.
 *
 * The rotation tests are the point: the answer to "I lost my key" has to issue a genuinely new
 * secret, kill the old one, and still refuse to reach across sites. A rotation that left the old
 * hash working would be worse than no feature at all — it would read as a revocation and not be one.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { createApiKey, listApiKeys, rotateApiKey, updateApiKey } = await import('./api-keys')
const { hmac } = await import('./crypto')

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

const env = { AUTH_SECRET: 'test-secret-not-a-real-one' } as unknown as Bindings

const site = (id: string, slug: string): SiteRow => ({
  id,
  slug,
  name: slug,
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
})

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })

  await db.insert(sites).values([site('site_1', 'blog'), site('site_2', 'docs')])
})

const issue = () =>
  createApiKey(env, 'site_1', { name: 'Marketing', scopes: ['content:read'] }, 'usr_1')

describe('renaming', () => {
  test('changes the label and nothing else', async () => {
    const created = await issue()
    const [before] = await db.select().from(apiKeys)

    const renamed = await updateApiKey(env, 'site_1', created.id, { name: 'Marketing site' })

    expect(renamed.name).toBe('Marketing site')
    expect(renamed.scopes).toEqual(['content:read'])

    const [after] = await db.select().from(apiKeys)
    // The credential itself is untouched — a rename must not silently re-issue anything.
    expect(after!.keyHash).toBe(before!.keyHash)
    expect(after!.prefix).toBe(before!.prefix)
  })

  test('cannot reach a key belonging to another site', async () => {
    const created = await issue()
    await expect(updateApiKey(env, 'site_2', created.id, { name: 'Stolen' })).rejects.toThrow(
      /not found/i,
    )
  })
})

describe('rotating', () => {
  test('issues a working new secret and kills the old one', async () => {
    const created = await issue()
    const rotated = await rotateApiKey(env, 'site_1', created.id)

    expect(rotated.id).toBe(created.id)
    expect(rotated.key).not.toBe(created.key)
    expect(rotated.key).toStartWith('hdg_')

    const [row] = await db.select().from(apiKeys)
    // The stored hash is the new secret's, so presenting the old one now resolves nothing.
    expect(row!.keyHash).toBe(await hmac(env.AUTH_SECRET, rotated.key))
    expect(row!.keyHash).not.toBe(await hmac(env.AUTH_SECRET, created.key))
  })

  test('keeps the identity of the key — same row, name, scopes and creation time', async () => {
    const created = await issue()
    const rotated = await rotateApiKey(env, 'site_1', created.id)

    expect(rotated.name).toBe('Marketing')
    expect(rotated.scopes).toEqual(['content:read'])
    expect(rotated.createdAt).toBe(created.createdAt)
    // One key in, one key out: rotating replaces rather than accumulates.
    expect(await listApiKeys(env, 'site_1')).toHaveLength(1)
  })

  test('updates the displayed prefix to match the new secret', async () => {
    const created = await issue()
    const rotated = await rotateApiKey(env, 'site_1', created.id)

    expect(rotated.prefix).toBe(rotated.key.slice(0, 12))
    expect(rotated.prefix).not.toBe(created.prefix)
  })

  test('clears last-used, which described the previous secret', async () => {
    const created = await issue()
    await db.update(apiKeys).set({ lastUsedAt: '2026-05-01T00:00:00.000Z' })

    const rotated = await rotateApiKey(env, 'site_1', created.id)
    expect(rotated.lastUsedAt).toBeNull()
  })

  test('cannot rotate a key belonging to another site', async () => {
    const created = await issue()
    await expect(rotateApiKey(env, 'site_2', created.id)).rejects.toThrow(/not found/i)

    // …and the key it refused to touch still works.
    const [row] = await db.select().from(apiKeys)
    expect(row!.keyHash).toBe(await hmac(env.AUTH_SECRET, created.key))
  })

  test('a missing key is a 404, not a fresh one', async () => {
    await expect(rotateApiKey(env, 'site_1', 'key_nope')).rejects.toThrow(/not found/i)
    expect(await listApiKeys(env, 'site_1')).toHaveLength(0)
  })
})
