import type { MigrationOutcome } from '@hedge/core'
import type { CloudflareClient } from './cloudflare/client'
import { d1Query } from './cloudflare/d1'
import { splitSqlStatements } from './sql-split'

/**
 * Applies pending D1 migrations from inside the Worker, over the D1 HTTP API — not the `DB` binding,
 * because the updater runs in the *old* Worker before the new version is live, and the migrations
 * have to land before any request reaches new code (issue #35's sequence).
 *
 * Compatibility with `wrangler d1 migrations apply` is the contract: same `d1_migrations` table,
 * same names (the filename *with* `.sql`), same ordering. Someone who updates from the dashboard
 * once and runs `db:migrate:remote` later must not re-run anything, and vice versa.
 *
 * Migrations are not transactional across files on D1, so a partial application is a state the
 * caller has to report honestly. This stops at the first failing statement and returns exactly how
 * far it got; it never continues past a failure.
 */

/** The table wrangler creates on the first remote apply. Recreated here only if it is absent. */
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`

export interface MigrationFile {
  /** The filename with its `.sql` extension — exactly what `d1_migrations.name` stores. */
  name: string
  sql: string
}

export interface MigrationRunResult {
  outcomes: MigrationOutcome[]
  /** True only if every pending migration applied. A single failure makes this false. */
  ok: boolean
  /** The name of the migration that failed, if any — the one an operator has to look at. */
  failedAt: string | null
}

/** The set of migration names already recorded as applied. */
export async function appliedMigrations(
  client: CloudflareClient,
  databaseId: string,
): Promise<Set<string>> {
  await d1Query(client, databaseId, CREATE_MIGRATIONS_TABLE)
  const [result] = await d1Query<{ name: string }>(
    client,
    databaseId,
    'SELECT name FROM d1_migrations',
  )
  return new Set((result?.results ?? []).map((row) => row.name))
}

/**
 * Apply every migration not yet in `d1_migrations`, in the order given (callers pass filename
 * order). Each file's statements run one at a time; the file is recorded only once all of them
 * succeed, so a crash mid-file leaves the file *un*recorded and a resumed run retries it — which is
 * safe because the migrations themselves guard with `IF NOT EXISTS` / `IF EXISTS`.
 */
export async function runMigrations(
  client: CloudflareClient,
  databaseId: string,
  migrations: MigrationFile[],
): Promise<MigrationRunResult> {
  const applied = await appliedMigrations(client, databaseId)
  const outcomes: MigrationOutcome[] = []

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue

    const statements = splitSqlStatements(migration.sql)
    try {
      for (const statement of statements) {
        await d1Query(client, databaseId, statement)
      }
    } catch (error) {
      outcomes.push({
        name: migration.name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      return { outcomes, ok: false, failedAt: migration.name }
    }

    // Record the migration as applied, matching wrangler's bookkeeping exactly.
    await d1Query(client, databaseId, 'INSERT INTO d1_migrations (name) VALUES (?)', [
      migration.name,
    ])
    outcomes.push({ name: migration.name, status: 'applied', error: null })
  }

  return { outcomes, ok: true, failedAt: null }
}
