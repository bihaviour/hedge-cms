import {
  createEntryVersionSchema,
  listEntryVersionsQuerySchema,
  reviewDecisionSchema,
  updateEntryVersionSchema,
} from '@hedge/core'
import { Hono } from 'hono'
import type { Actor, AppEnv } from '../env'
import {
  approvalLevelFor,
  requireActor,
  requireScope,
  requireSitePermission,
  requireUserActor,
} from '../lib/auth'
import {
  createEntryVersion,
  decideEntryVersion,
  discardEntryVersion,
  getEntryVersion,
  listEntryVersions,
  publishEntryVersion,
  submitEntryVersion,
  updateEntryVersion,
} from '../lib/entry-versions'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'

/**
 * Version routes, mounted under the entries router so they sit at
 * `/api/v1/collections/:collection/entries/:slug/versions`.
 *
 * `/api/v1/collections` is in `KEY_MANAGED_PREFIXES`, so a write-scoped API key resolves on every
 * route in this file by default. That is right for authoring — an import script may well draft a
 * version — and wrong for approving, so the three decision routes carry `requireUserActor`
 * explicitly rather than trusting the prefix to have the right shape. An approval is a statement by
 * a person, and the credential that can author is the one most likely to be automated.
 */
const app = new Hono<AppEnv>()

/** Only a person is recorded as an author; a key or a delegated client leaves the column null. */
const authorId = (actor: Actor) => (actor.kind === 'user' ? actor.id : null)

const params = (c: { req: { param: (key: string) => string } }) => ({
  collection: c.req.param('collection'),
  slug: c.req.param('slug'),
})

app.get('/', requireSitePermission('entries:read'), requireScope('content:read'), async (c) => {
  const query = validateQuery(c, listEntryVersionsQuerySchema)
  const { collection, slug } = params(c)
  const data = await listEntryVersions(
    c.env,
    requireSite(c),
    collection,
    slug,
    query,
    c.req.query('locale'),
  )
  return c.json({ data })
})

app.get(
  '/:versionId',
  requireSitePermission('entries:read'),
  requireScope('content:read'),
  async (c) => {
    const { collection, slug } = params(c)
    const data = await getEntryVersion(
      c.env,
      requireSite(c),
      collection,
      slug,
      c.req.param('versionId'),
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

app.post('/', requireSitePermission('entries:update'), requireScope('content:write'), async (c) => {
  const input = await validate(c, createEntryVersionSchema)
  const { collection, slug } = params(c)
  const data = await createEntryVersion(
    c.env,
    requireSite(c),
    collection,
    slug,
    input,
    authorId(requireActor(c)),
    c.req.query('locale'),
  )
  return c.json({ data }, 201)
})

app.patch(
  '/:versionId',
  requireSitePermission('entries:update'),
  requireScope('content:write'),
  async (c) => {
    const input = await validate(c, updateEntryVersionSchema)
    const { collection, slug } = params(c)
    const data = await updateEntryVersion(
      c.env,
      requireSite(c),
      collection,
      slug,
      c.req.param('versionId'),
      input,
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

app.delete(
  '/:versionId',
  requireSitePermission('entries:update'),
  requireScope('content:write'),
  async (c) => {
    const { collection, slug } = params(c)
    const data = await discardEntryVersion(
      c.env,
      requireSite(c),
      collection,
      slug,
      c.req.param('versionId'),
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

app.post(
  '/:versionId/submit',
  requireSitePermission('entries:update'),
  requireScope('content:write'),
  async (c) => {
    const { collection, slug } = params(c)
    const data = await submitEntryVersion(
      c.env,
      requireSite(c),
      collection,
      slug,
      c.req.param('versionId'),
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

/* ------------------------------------------------------------------ *
 * Decisions. A machine never approves — hence `requireUserActor` on all three, on top of the site
 * role and the caller's own approval level, which `decideEntryVersion` checks against the level
 * being cleared.
 * ------------------------------------------------------------------ */

for (const [path, decision] of [
  ['/:versionId/approve', 'approved'],
  ['/:versionId/reject', 'rejected'],
] as const) {
  app.post(
    path,
    requireSitePermission('entries:update'),
    requireScope('content:write'),
    async (c) => {
      const { comment } = await validate(c, reviewDecisionSchema)
      const actor = requireUserActor(c)
      const site = requireSite(c)
      const { collection, slug } = params(c)

      const data = await decideEntryVersion(
        c.env,
        site,
        collection,
        slug,
        c.req.param('versionId'),
        decision,
        {
          userId: actor.id,
          approverLevel: await approvalLevelFor(c.env, actor, site.id),
          comment,
        },
        c.req.query('locale'),
      )
      return c.json({ data })
    },
  )
}

app.post(
  '/:versionId/publish',
  requireSitePermission('entries:update'),
  requireScope('content:write'),
  async (c) => {
    const actor = requireUserActor(c)
    const { collection, slug } = params(c)
    const data = await publishEntryVersion(
      c.env,
      requireSite(c),
      collection,
      slug,
      c.req.param('versionId'),
      actor.id,
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

export default app
