import type { SiteRole } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { approvalLevelFor, currentSiteRole, requireSiteRole, requireUserActor } from '../lib/auth'
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
 * a control for still runs its own `requireSiteRole`.
 */
const app = new Hono<AppEnv>()

app.get('/', requireSiteRole('viewer'), async (c) => {
  const actor = requireUserActor(c)
  // `requireSiteRole` has already refused a caller with no role here, and a user's site role only
  // ever comes from a `site_users` grant or from `sites:access_all` resolving to admin — both site
  // roles. The wider `Role` the resolver is typed with is the instance ordering it shares.
  const role = (await currentSiteRole(c)) as SiteRole
  const approvalLevel = await approvalLevelFor(c.env, actor, requireSite(c).id)
  return c.json({ data: { role, approvalLevel } })
})

export default app
