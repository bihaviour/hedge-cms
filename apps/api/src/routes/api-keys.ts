import { createApiKeySchema, updateApiKeySchema } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  rotateApiKey,
  updateApiKey,
} from '../lib/api-keys'
import { requireActor, requireSitePermission } from '../lib/auth'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

// Keys read a whole site's content, so each route asks for its own verb rather than the whole of
// `api_keys` (#154) — seeing which keys exist and issuing a new one are different powers, and a
// mounted gate could not tell them apart.

/** Keys belong to a site — the list only ever shows the one the admin is currently in. */
app.get('/', requireSitePermission('api_keys:read'), async (c) => {
  return c.json({ data: await listApiKeys(c.env, requireSite(c).id) })
})

app.post('/', requireSitePermission('api_keys:create'), async (c) => {
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

/** Renaming only — see `updateApiKey` for why scopes are not editable in place. */
app.patch('/:id', requireSitePermission('api_keys:update'), async (c) => {
  const input = await validate(c, updateApiKeySchema)
  return c.json({ data: await updateApiKey(c.env, requireSite(c).id, c.req.param('id'), input) })
})

/**
 * Issues a new secret for a key whose old one was lost, and returns it — the second and last place
 * a raw key exists outside a hash. The previous secret is dead on return, so this is as destructive
 * as a delete for anything still holding it; the admin confirms before calling it.
 */
app.post('/:id/rotate', requireSitePermission('api_keys:update'), async (c) => {
  const data = await rotateApiKey(c.env, requireSite(c).id, c.req.param('id'))
  return c.json({ data })
})

app.delete('/:id', requireSitePermission('api_keys:delete'), async (c) => {
  await deleteApiKey(c.env, requireSite(c).id, c.req.param('id'))
  return c.body(null, 204)
})

export default app
