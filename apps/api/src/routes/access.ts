import type { SiteRole } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import {
  approvalLevelFor,
  currentSitePermissions,
  currentSiteRole,
  requireUserActor,
} from '../lib/auth'
import { ApiError } from '../lib/errors'
import { requireSite } from '../lib/site'

/**
 * What the signed-in person may do on the active site.
 *
 * Site authority is per site and the session is not — the same user can be an admin on one site and
 * a viewer on the next — so `/auth/me` cannot carry it, and the admin has to ask per site. Without
 * that answer every site-admin control renders for everyone and reports the refusal as a toast,
 * which reads as a broken CMS rather than as a permission the account does not hold.
 *
 * In `ADMIN_PREFIXES`, and `requireUserActor` says the same thing a second time: a machine has no
 * UI to gate, and `approvalLevelFor` returns 0 for anything that is not a session actor anyway.
 *
 * This is the one place the question is answered, so the review inbox and the entry editor read the
 * same row as the collection settings page. The gating it drives is cosmetic — every route it hides
 * a control for still runs its own `requireSitePermission`.
 *
 * **It carries no permission gate of its own**, which every other site route now does. Asking what
 * you may do is not one of the things you may do: a role that grants nothing still has to be able
 * to learn that, or the admin cannot render the empty state it should. Reaching the site at all is
 * the whole requirement, and that is what a `null` set means.
 */
const app = new Hono<AppEnv>()

app.get('/', async (c) => {
  const actor = requireUserActor(c)
  const site = requireSite(c)
  const permissions = await currentSitePermissions(c)
  if (!permissions) throw ApiError.forbidden(`You do not have access to the "${site.slug}" site`)

  // A user's site role only ever comes from a `site_users` grant or from `sites:access_all`
  // resolving to admin — both site roles. The wider `Role` the resolver is typed with is the
  // instance ordering it shares.
  const role = (await currentSiteRole(c)) as SiteRole
  const approvalLevel = await approvalLevelFor(c.env, actor, site.id)
  // The set is what a control should gate on (#151): the slug beside it is a name, and two roles
  // called the same thing on two deployments no longer mean the same thing.
  return c.json({ data: { role, approvalLevel, permissions } })
})

export default app
