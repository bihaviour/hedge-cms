import { describe, expect, test } from 'bun:test'
import type { CloudflareClient } from './cloudflare/client'
import { runMigrations } from './migrate'

/**
 * A fake D1 over the HTTP client interface: it records every statement and keeps its own
 * `d1_migrations` set, so the runner's bookkeeping and stop-at-first-failure semantics are testable
 * without a live database. `failOn` makes one statement throw, standing in for a Cloudflare error.
 */
function fakeD1(options: { applied?: string[]; failOn?: string } = {}) {
  const applied = new Set(options.applied ?? [])
  const statements: string[] = []

  const client: CloudflareClient = {
    accountId: 'acct',
    async request<T>(_method: string, path: string, body?: unknown): Promise<T> {
      if (!path.includes('/d1/database/')) throw new Error(`unexpected call: ${path}`)
      const { sql, params } = body as { sql: string; params?: string[] }
      statements.push(sql)

      if (options.failOn && sql.includes(options.failOn)) throw new Error('D1 statement failed')

      if (/^\s*CREATE TABLE IF NOT EXISTS "d1_migrations"/.test(sql)) {
        return [{ results: [], success: true, meta: {} }] as T
      }
      if (/SELECT name FROM d1_migrations/.test(sql)) {
        return [{ results: [...applied].map((name) => ({ name })), success: true, meta: {} }] as T
      }
      if (/INSERT INTO d1_migrations/.test(sql)) {
        applied.add(params?.[0] ?? '')
        return [{ results: [], success: true, meta: {} }] as T
      }
      return [{ results: [], success: true, meta: {} }] as T
    },
    async requestForm<T>(): Promise<T> {
      throw new Error('not used')
    },
  }

  return { client, applied, statements }
}

const MIGRATIONS = [
  { name: '0000_a.sql', sql: 'CREATE TABLE a (id text);' },
  { name: '0001_b.sql', sql: 'CREATE TABLE b (id text);\nCREATE INDEX b_idx ON b (id);' },
  { name: '0002_c.sql', sql: 'CREATE TABLE c (id text);' },
]

describe('runMigrations', () => {
  test('applies every pending migration in order and records each name', async () => {
    const { client, applied } = fakeD1()
    const result = await runMigrations(client, 'db', MIGRATIONS)

    expect(result.ok).toBe(true)
    expect(result.outcomes.map((o) => o.name)).toEqual(['0000_a.sql', '0001_b.sql', '0002_c.sql'])
    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true)
    expect(applied).toEqual(new Set(['0000_a.sql', '0001_b.sql', '0002_c.sql']))
  })

  test('skips migrations already recorded — idempotent with wrangler', async () => {
    const { client } = fakeD1({ applied: ['0000_a.sql', '0001_b.sql'] })
    const result = await runMigrations(client, 'db', MIGRATIONS)

    expect(result.ok).toBe(true)
    expect(result.outcomes.map((o) => o.name)).toEqual(['0002_c.sql'])
  })

  test('stops at the first failing migration and never records or continues past it', async () => {
    const { client, applied } = fakeD1({ failOn: 'TABLE b' })
    const result = await runMigrations(client, 'db', MIGRATIONS)

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe('0001_b.sql')
    expect(result.outcomes.map((o) => `${o.name}:${o.status}`)).toEqual([
      '0000_a.sql:applied',
      '0001_b.sql:failed',
    ])
    // The failed migration is not recorded, and 0002 is never attempted.
    expect(applied.has('0001_b.sql')).toBe(false)
    expect(applied.has('0002_c.sql')).toBe(false)
  })
})
