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

// What the caller may approve here is answered by `GET /api/v1/access`, not by a route of this
// module's own: the entry editor and the collection settings page ask the same question about the
// same site, and two routes answering it is two answers to keep in step.

/** Who is asking, and what they may approve here — the pair both queue routes filter on. */
async function reviewer(c: Parameters<typeof requireUserActor>[0]) {
  const actor = requireUserActor(c)
  const site = requireSite(c)
  return { site, reviewer: { id: actor.id, level: await approvalLevelFor(c.env, actor, site.id) } }
}

app.get('/queue', requireSiteRole('editor'), async (c) => {
  const query = validateQuery(c, reviewQueueQuerySchema)
  const { site, reviewer: who } = await reviewer(c)
  return c.json(await listReviewQueue(c.env, site, query, who))
})

/** Just the number, for the sidebar badge. Polls on the admin's existing query cadence. */
app.get('/queue/count', requireSiteRole('editor'), async (c) => {
  const { site, reviewer: who } = await reviewer(c)
  return c.json({ data: { count: await countReviewQueue(c.env, site, who) } })
})

export default app
