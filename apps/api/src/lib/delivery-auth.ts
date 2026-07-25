import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { getDb } from '../db/client'
import { apiKeys } from '../db/schema'
import type { AppEnv } from '../env'
import { API_KEY_PREFIX } from './auth'
import { hmac } from './crypto'

/**
 * Resolves a delivery API key from `Authorization: Bearer hdg_…`.
 *
 * Mounted on `/api/v1/content/*` and nowhere else. That placement is the point: a key lives in a
 * website's environment variables, which is the least protected place any Hedge credential sits, so
 * it must not be able to reach a management route even if one forgets a role check. Before this
 * split a key with `content:write` resolved to role `editor` everywhere.
 */
export const resolveDeliveryActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization')
  const raw = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null

  if (!raw?.startsWith(API_KEY_PREFIX)) {
    c.set('actor', null)
    await next()
    return
  }

  const db = getDb(c.env)
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, await hmac(c.env.AUTH_SECRET, raw)))
    .limit(1)

  const expired = row?.expiresAt ? new Date(row.expiresAt).getTime() < Date.now() : false

  if (!row || expired) {
    c.set('actor', null)
    await next()
    return
  }

  // Best-effort usage tracking; never block the request on it.
  c.executionCtx.waitUntil(
    db
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, row.id))
      .then(() => undefined),
  )

  const canWrite = row.scopes.some((scope) => scope.endsWith(':write'))
  c.set('actor', {
    kind: 'api_key',
    via: 'api_key',
    id: row.id,
    role: canWrite ? 'editor' : 'viewer',
    scopes: row.scopes,
    siteId: row.siteId,
  })
  await next()
}
