import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mcpClientGrants, users } from '../db/schema'
import type { Bindings } from '../env'

/**
 * The grant table, against a real SQLite built from the committed migrations.
 *
 * One claim carries this feature's back-compatibility and cannot be seen by using the product:
 * **an unrecorded grant means granted**. Every consent given before #145 has no row, and a default
 * of "declined" would have refused every delete for every existing client on the day it shipped.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { destructiveGrantFor, destructiveGrantsFor, setDestructiveGrant } = await import(
  './mcp-grants'
)

const MIGRATIONS = join(import.meta.dir, '../../migrations')

function migrate(sqlite: Database) {
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
}

const env = {} as Bindings

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite)

  await db.insert(users).values({ id: 'usr_1', email: 'a@example.com', name: 'A', role: 'admin' })
})

describe('destructiveGrantFor', () => {
  test('is true when nothing was recorded', async () => {
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(true)
  })

  test('is false once the operator declines', async () => {
    await setDestructiveGrant(env, 'usr_1', 'client_a', false)
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(false)
  })

  test('is per client, not per user', async () => {
    await setDestructiveGrant(env, 'usr_1', 'client_a', false)
    expect(await destructiveGrantFor(env, 'usr_1', 'client_b')).toBe(true)
  })
})

describe('setDestructiveGrant', () => {
  test('re-approving the same client replaces the answer rather than adding a row', async () => {
    // The unique index is what makes this an upsert. Two rows for one pair would make the read
    // order-dependent, which for an authorisation answer is a coin toss.
    await setDestructiveGrant(env, 'usr_1', 'client_a', false)
    await setDestructiveGrant(env, 'usr_1', 'client_a', true)

    expect(await db.select().from(mcpClientGrants)).toHaveLength(1)
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(true)
  })
})

describe('destructiveGrantsFor', () => {
  test('returns only what was recorded, so the caller applies the default itself', async () => {
    await setDestructiveGrant(env, 'usr_1', 'client_a', false)
    const grants = await destructiveGrantsFor(env, 'usr_1')

    expect(grants.get('client_a')).toBe(false)
    // Absent rather than `true`: the map says what was decided, and "nothing was decided" is the
    // caller's to interpret — the same distinction the endpoint makes.
    expect(grants.has('client_b')).toBe(false)
  })
})
