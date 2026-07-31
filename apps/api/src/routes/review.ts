import { reviewQueueQuerySchema } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { approvalLevelFor, requireSiteRole, requireUserActor } from '../lib/auth'
import { countReviewQueue, listReviewQueue } from '../lib/entry-versions'
import { requireSite } from '../lib/site'
import { validateQuery } from '../lib/validate'

/**
 * The review inbox — what is waiting on the signed-in person, for the active site.
 *
 * In `ADMIN_PREFIXES`, not `KEY_MANAGED_PREFIXES`: this is somebody's queue of decisions to make,
 * and a machine never makes one. `requireUserActor` says the same thing a second time, because a
 * prefix list is a place a route can quietly be added to the wrong half of.
 *
 * Every route here filters on `(siteId, status)` — the index `entry_versions` declares — so the
 * queue is a per-site query and never becomes a scan across every tenant's content.
 */
const app = new Hono<AppEnv>()

/**
 * What the caller may approve on this site. Its own route because the entry editor needs the same
 * answer as the inbox does, to show the review actions it will actually be allowed to take rather
 * than an approve button that 403s.
 */
app.get('/authority', requireSiteRole('viewer'), async (c) => {
  const actor = requireUserActor(c)
  const approvalLevel = await approvalLevelFor(c.env, actor, requireSite(c).id)
  return c.json({ data: { approvalLevel } })
})

app.get('/queue', requireSiteRole('editor'), async (c) => {
  const actor = requireUserActor(c)
  const query = validateQuery(c, reviewQueueQuerySchema)
  const site = requireSite(c)

  return c.json(
    await listReviewQueue(c.env, site, query, await approvalLevelFor(c.env, actor, site.id)),
  )
})

/** Just the number, for the sidebar badge. Polls on the admin's existing query cadence. */
app.get('/queue/count', requireSiteRole('editor'), async (c) => {
  const actor = requireUserActor(c)
  const site = requireSite(c)
  const count = await countReviewQueue(c.env, site, await approvalLevelFor(c.env, actor, site.id))
  return c.json({ data: { count } })
})

export default app
