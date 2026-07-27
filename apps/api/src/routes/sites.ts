import {
  createSiteSchema,
  roleAtLeast,
  updateSiteConfigSchema,
  updateSiteSchema,
} from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { accessibleSites, requireActor, requirePermission, siteRoleFor } from '../lib/auth'
import { ApiError } from '../lib/errors'
import {
  createSite,
  deleteSite,
  findSite,
  toSite,
  updateSite,
  updateSiteConfig,
} from '../lib/sites'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

/**
 * The sites this caller can reach — every site for owners and admins, granted ones for everyone
 * else, and just its own for an API key. This is what fills the admin's site switcher, so a
 * user is never offered a site they would be refused on.
 */
app.get('/', async (c) => {
  const rows = await accessibleSites(c.env, requireActor(c))
  return c.json({ data: rows.map(toSite) })
})

// The response carries a raw delivery-key secret (`data.deliveryKey.key`), the only time it is ever
// returned — like `POST /api-keys`, treat it accordingly in logging and anything recording bodies.
app.post('/', requirePermission('sites:create'), async (c) => {
  const input = await validate(c, createSiteSchema)
  return c.json({ data: await createSite(c.env, input) }, 201)
})

app.get('/:slug', async (c) => {
  const row = await findSite(c.env, c.req.param('slug'))
  // Not a 403: a user without access has no business learning which sites exist.
  if (!(await siteRoleFor(c.env, requireActor(c), row.id))) throw ApiError.notFound('Site')
  return c.json({ data: toSite(row) })
})

app.patch('/:slug', requirePermission('sites:update'), async (c) => {
  const input = await validate(c, updateSiteSchema)
  return c.json({ data: await updateSite(c.env, c.req.param('slug'), input) })
})

/**
 * A site's metadata defaults and custom fields. Authorised at the site level — a per-site admin
 * owns their own site's content configuration — rather than requiring an instance admin the way
 * renaming or re-domaining a site does. Role is checked against the site named in the path, exactly
 * as `GET /:slug` does, so the active-site header cannot widen a caller's reach here.
 */
app.patch('/:slug/config', async (c) => {
  const existing = await findSite(c.env, c.req.param('slug'))

  const role = await siteRoleFor(c.env, requireActor(c), existing.id)
  if (!role || !roleAtLeast(role, 'admin')) {
    throw ApiError.forbidden('Site admin access is required to change site settings')
  }

  const input = await validate(c, updateSiteConfigSchema)
  return c.json({ data: await updateSiteConfig(c.env, existing.id, input) })
})

app.delete('/:slug', requirePermission('sites:delete'), async (c) => {
  await deleteSite(c.env, c.req.param('slug'))
  return c.body(null, 204)
})

export default app
