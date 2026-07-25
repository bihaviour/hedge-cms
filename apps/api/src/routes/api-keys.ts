import { type ApiKey, createApiKeySchema } from '@hedge/core'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { type ApiKeyRow, apiKeys } from '../db/schema'
import type { AppEnv } from '../env'
import { generateApiKey, requireActor, requireRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

app.use('*', requireRole('admin'))

function toApiKey(row: ApiKeyRow): ApiKey {
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

app.get('/', async (c) => {
  const db = getDb(c.env)
  const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt))
  return c.json({ data: rows.map(toApiKey) })
})

app.post('/', async (c) => {
  const input = await validate(c, createApiKeySchema)
  const actor = requireActor(c)
  const db = getDb(c.env)

  const { raw, row } = await generateApiKey(c.env, input.name, input.scopes)
  const [created] = await db
    .insert(apiKeys)
    .values({
      ...row,
      expiresAt: input.expiresAt ?? null,
      createdBy: actor.kind === 'user' ? actor.id : null,
    })
    .returning()

  // The only time the raw key is ever returned — it is stored hashed.
  return c.json({ data: { ...toApiKey(created!), key: raw } }, 201)
})

app.delete('/:id', async (c) => {
  const db = getDb(c.env)
  const [row] = await db
    .delete(apiKeys)
    .where(eq(apiKeys.id, c.req.param('id')))
    .returning()
  if (!row) throw ApiError.notFound('API key')
  return c.body(null, 204)
})

export default app
