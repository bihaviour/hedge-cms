import { createRoleSchema, updateRoleSchema } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requireActor, requirePermission } from '../lib/auth'
import { createRole, deleteRole, listRoles, updateRole } from '../lib/roles'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

/**
 * Instance roles. Listing is open to any signed-in operator — the invite and role-change dropdowns
 * need it, and a role definition is not a secret. Defining, editing and deleting are gated on
 * `roles:manage`, and a role can never be given a permission the operator defining it lacks (that
 * guard lives in `lib/roles.ts`, so it holds for the MCP surface too if it ever grows these tools).
 */
app.get('/', async (c) => {
  requireActor(c)
  return c.json({ data: await listRoles(c.env) })
})

app.post('/', requirePermission('roles:manage'), async (c) => {
  const input = await validate(c, createRoleSchema)
  return c.json({ data: await createRole(c.env, input, requireActor(c).permissions) }, 201)
})

app.patch('/:slug', requirePermission('roles:manage'), async (c) => {
  const input = await validate(c, updateRoleSchema)
  const data = await updateRole(c.env, c.req.param('slug'), input, requireActor(c).permissions)
  return c.json({ data })
})

app.delete('/:slug', requirePermission('roles:manage'), async (c) => {
  await deleteRole(c.env, c.req.param('slug'))
  return c.body(null, 204)
})

export default app
