import { createCollectionSchema, updateCollectionSchema } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requireScope, requireSiteRole } from '../lib/auth'
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  updateCollection,
} from '../lib/collections'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

app.get('/', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  return c.json({ data: await listCollections(c.env, requireSite(c).id) })
})

app.get('/:slug', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  return c.json({ data: await getCollection(c.env, requireSite(c).id, c.req.param('slug')) })
})

app.post('/', requireSiteRole('admin'), requireScope('collections:write'), async (c) => {
  const input = await validate(c, createCollectionSchema)
  return c.json({ data: await createCollection(c.env, requireSite(c).id, input) }, 201)
})

app.patch('/:slug', requireSiteRole('admin'), requireScope('collections:write'), async (c) => {
  const input = await validate(c, updateCollectionSchema)
  const data = await updateCollection(c.env, requireSite(c).id, c.req.param('slug'), input)
  return c.json({ data })
})

app.delete('/:slug', requireSiteRole('admin'), requireScope('collections:write'), async (c) => {
  await deleteCollection(c.env, requireSite(c).id, c.req.param('slug'))
  return c.body(null, 204)
})

export default app
