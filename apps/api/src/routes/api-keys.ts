import { createApiKeySchema } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { createApiKey, deleteApiKey, listApiKeys } from '../lib/api-keys'
import { requireActor, requireSiteRole } from '../lib/auth'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

// Keys read a whole site's content, so issuing them is a site-admin power.
app.use('*', requireSiteRole('admin'))

/** Keys belong to a site — the list only ever shows the one the admin is currently in. */
app.get('/', async (c) => {
  return c.json({ data: await listApiKeys(c.env, requireSite(c).id) })
})

app.post('/', async (c) => {
  const input = await validate(c, createApiKeySchema)
  const actor = requireActor(c)
  // The only time the raw key is ever returned — it is stored hashed.
  const data = await createApiKey(
    c.env,
    requireSite(c).id,
    input,
    actor.kind === 'user' ? actor.id : null,
  )
  return c.json({ data }, 201)
})

app.delete('/:id', async (c) => {
  await deleteApiKey(c.env, requireSite(c).id, c.req.param('id'))
  return c.body(null, 204)
})

export default app
