import { drizzle } from 'drizzle-orm/d1'
import type { Bindings } from '../env'
import * as schema from './schema'

export type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * D1 connections are per-request and cheap to construct, so there is nothing to pool —
 * this just keeps the schema wiring in one place.
 */
export function getDb(env: Bindings): Db {
  return drizzle(env.DB, { schema, casing: 'snake_case' })
}

export { schema }
