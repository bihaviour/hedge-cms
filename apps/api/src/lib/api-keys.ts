import type { ApiKey, CreateApiKeyInput } from '@hedge/core'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type ApiKeyRow, apiKeys } from '../db/schema'
import type { Bindings } from '../env'
import { generateApiKey } from './auth'
import { ApiError } from './errors'

/**
 * API key management, factored out of the HTTP route so the REST API and the MCP endpoint share it.
 * Keys belong to a site, so every function is scoped to one.
 */

export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as ApiKey['scopes'],
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

export async function listApiKeys(env: Bindings, siteId: string): Promise<ApiKey[]> {
  const rows = await getDb(env)
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.siteId, siteId))
    .orderBy(desc(apiKeys.createdAt))
  return rows.map(toApiKey)
}

/**
 * Issues a key. The returned `key` is the raw secret and is the **only** time it exists outside a
 * hash — nothing can read it back afterwards, so a caller that drops it has to issue another.
 */
export async function createApiKey(
  env: Bindings,
  siteId: string,
  input: CreateApiKeyInput,
  actorId: string | null,
): Promise<ApiKey & { key: string }> {
  const { raw, row } = await generateApiKey(env, siteId, input.name, input.scopes)

  const [created] = await getDb(env)
    .insert(apiKeys)
    .values({
      ...row,
      expiresAt: input.expiresAt ?? null,
      createdBy: actorId,
    })
    .returning()

  return { ...toApiKey(created!), key: raw }
}

export async function deleteApiKey(env: Bindings, siteId: string, id: string): Promise<void> {
  const [row] = await getDb(env)
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.siteId, siteId)))
    .returning({ id: apiKeys.id })

  if (!row) throw ApiError.notFound('API key')
}
