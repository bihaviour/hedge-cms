import { ROLES, setSiteRoleSchema } from '@hedge/core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { requireActor, requireRole } from '../lib/auth'
import {
  deleteUser,
  listUserSites,
  listUsers,
  removeUserSiteRole,
  setUserSiteRole,
  updateUser,
} from '../lib/users'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

app.get('/', requireRole('admin'), async (c) => {
  return c.json({ data: await listUsers(c.env) })
})

app.patch('/:id', requireRole('admin'), async (c) => {
  const input = await validate(
    c,
    z.object({
      name: z.string().min(1).max(120).optional(),
      role: z.enum(ROLES).optional(),
    }),
  )
  const data = await updateUser(c.env, c.req.param('id'), input, requireActor(c).id)
  return c.json({ data })
})

/* ------------------------------------------------------------------ *
 * Per-site access. Owners and admins reach every site, so they never appear here — these
 * grants are what give an editor or viewer a site at all.
 * ------------------------------------------------------------------ */

/** The sites this user has been granted, for the admin's access editor. */
app.get('/:id/sites', requireRole('admin'), async (c) => {
  return c.json({ data: await listUserSites(c.env, c.req.param('id')) })
})

app.put('/:id/sites/:siteId', requireRole('admin'), async (c) => {
  const { role } = await validate(c, setSiteRoleSchema)
  const data = await setUserSiteRole(c.env, c.req.param('id'), c.req.param('siteId'), role)
  return c.json({ data })
})

app.delete('/:id/sites/:siteId', requireRole('admin'), async (c) => {
  await removeUserSiteRole(c.env, c.req.param('id'), c.req.param('siteId'))
  return c.body(null, 204)
})

app.delete('/:id', requireRole('admin'), async (c) => {
  await deleteUser(c.env, c.req.param('id'), requireActor(c).id)
  return c.body(null, 204)
})

export default app
