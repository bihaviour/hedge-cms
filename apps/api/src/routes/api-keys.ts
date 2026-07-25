import { type ApiKey, createApiKeySchema } from '@hedge/core'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { type ApiKeyRow, apiKeys } from '../db/schema'
import type { AppEnv } from '../env'
import { generateApiKey, requireActor, requireSiteRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

// Keys read a whole site's content, so issuing them is a site-admin power.
app.use('*', requireSiteRole('admin'))

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

/** Keys belong to a site — the list only ever shows the one the admin is currently in. */
app.get('/', async (c) => {
  const site = requireSite(c)
  const rows = await getDb(c.env)
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.siteId, site.id))
    .orderBy(desc(apiKeys.createdAt))
  return c.json({ data: rows.map(toApiKey) })
})

app.post('/', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, createApiKeySchema)
  const actor = requireActor(c)
  const db = getDb(c.env)

  const { raw, row } = await generateApiKey(c.env, site.id, input.name, input.scopes)
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
  const site = requireSite(c)
  const db = getDb(c.env)
  const [row] = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, c.req.param('id')), eq(apiKeys.siteId, site.id)))
    .returning()
  if (!row) throw ApiError.notFound('API key')
  return c.body(null, 204)
})

export default app
