import type { ApiKey, CreateApiKeyInput, UpdateApiKeyInput } from '@hedge/core'
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

/**
 * Renames a key. Only the label moves: the secret, its scopes and the site it belongs to are what
 * the credential *is*, and editing any of those in place would change what a deployed key can do
 * without anyone re-issuing it.
 */
export async function updateApiKey(
  env: Bindings,
  siteId: string,
  id: string,
  input: UpdateApiKeyInput,
): Promise<ApiKey> {
  const [row] = await getDb(env)
    .update(apiKeys)
    .set({ name: input.name })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.siteId, siteId)))
    .returning()

  if (!row) throw ApiError.notFound('API key')
  return toApiKey(row)
}

/**
 * Issues a new secret for an existing key, keeping its id, name, scopes and expiry.
 *
 * This is the answer to "I lost the key" — there is no other, because only the HMAC is stored and
 * nothing can read the original back. The old secret stops working the instant this returns, so a
 * consumer still holding it starts failing immediately; that is the point of rotating rather than a
 * side effect of it. `lastUsedAt` resets because it described the previous secret.
 */
export async function rotateApiKey(
  env: Bindings,
  siteId: string,
  id: string,
): Promise<ApiKey & { key: string }> {
  const db = getDb(env)

  const [existing] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.siteId, siteId)))
    .limit(1)

  if (!existing) throw ApiError.notFound('API key')

  const { raw, row } = await generateApiKey(env, siteId, existing.name, existing.scopes)

  const [updated] = await db
    .update(apiKeys)
    .set({ prefix: row.prefix, keyHash: row.keyHash, lastUsedAt: null })
    // The site is re-checked here as well as in the select above: the two statements are not one
    // transaction, and a key row must never be reachable from a site that does not own it.
    .where(and(eq(apiKeys.id, id), eq(apiKeys.siteId, siteId)))
    .returning()

  if (!updated) throw ApiError.notFound('API key')
  return { ...toApiKey(updated), key: raw }
}

export async function deleteApiKey(env: Bindings, siteId: string, id: string): Promise<void> {
  const [row] = await getDb(env)
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.siteId, siteId)))
    .returning({ id: apiKeys.id })

  if (!row) throw ApiError.notFound('API key')
}
