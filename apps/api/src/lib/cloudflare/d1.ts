import type { CloudflareClient } from './client'

/**
 * The D1 HTTP query API. The migration runner (#34) uses this rather than the `DB` binding on
 * purpose: the updater executes in the *old* Worker, before the new version is live, so it applies
 * migrations to the target database over HTTP exactly the way `wrangler d1 migrations apply --remote`
 * does — same database, same parser to answer to, same `d1_migrations` bookkeeping.
 */

export interface D1QueryResult<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: Record<string, unknown>
}

/**
 * Run one SQL statement against a database. D1 returns an array of results (one per statement), but
 * the runner submits a single statement at a time — it owns the splitting so it can stop at the
 * exact file and statement that failed — so callers take `results[0]`.
 */
export async function d1Query<T = Record<string, unknown>>(
  client: CloudflareClient,
  databaseId: string,
  sql: string,
  params: string[] = [],
): Promise<D1QueryResult<T>[]> {
  return client.request<D1QueryResult<T>[]>(
    'POST',
    `/accounts/${client.accountId}/d1/database/${databaseId}/query`,
    { sql, params },
  )
}

/**
 * Resolve a database's id from its name — the fallback when the running script's `DB` binding
 * doesn't hand one over (it normally does, which is the account-specific id `wrangler.jsonc` omits).
 */
export async function findDatabaseId(
  client: CloudflareClient,
  name: string,
): Promise<string | null> {
  const result = await client.request<Array<{ uuid: string; name: string }>>(
    'GET',
    `/accounts/${client.accountId}/d1/database?name=${encodeURIComponent(name)}`,
  )
  return result.find((db) => db.name === name)?.uuid ?? null
}
