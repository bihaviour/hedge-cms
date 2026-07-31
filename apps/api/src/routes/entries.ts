import {
  createEntrySchema,
  createPreviewTokenSchema,
  listEntriesQuerySchema,
  updateEntrySchema,
} from '@hedge/core'
import { Hono } from 'hono'
import type { Actor, AppEnv } from '../env'
import { requireActor, requireScope, requireSiteRole, requireUserActor } from '../lib/auth'
import {
  createEntry,
  deleteEntry,
  getEntry,
  listEntries,
  listEntryRevisions,
  restoreEntryRevision,
  updateEntry,
} from '../lib/entries'
import { mintPreviewToken } from '../lib/preview'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'
import entryVersions from './entry-versions'

const app = new Hono<AppEnv>()

/** Only a person is recorded as an author; a key or a delegated client leaves the column null. */
const authorId = (actor: Actor) => (actor.kind === 'user' ? actor.id : null)

app.get('/', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  const query = validateQuery(c, listEntriesQuerySchema)
  const page = await listEntries(
    c.env,
    requireSite(c),
    c.req.param('collection')!,
    query,
    new URL(c.req.url).searchParams,
  )
  return c.json(page)
})

app.get('/:slug', requireSiteRole('viewer'), requireScope('content:read'), async (c) => {
  const data = await getEntry(
    c.env,
    requireSite(c),
    c.req.param('collection')!,
    c.req.param('slug'),
    c.req.query('locale'),
  )
  return c.json({ data })
})

app.post('/', requireSiteRole('editor'), requireScope('content:write'), async (c) => {
  const input = await validate(c, createEntrySchema)
  const data = await createEntry(
    c.env,
    requireSite(c),
    c.req.param('collection')!,
    input,
    authorId(requireActor(c)),
  )
  return c.json({ data }, 201)
})

app.patch('/:slug', requireSiteRole('editor'), requireScope('content:write'), async (c) => {
  const input = await validate(c, updateEntrySchema)
  const data = await updateEntry(
    c.env,
    requireSite(c),
    c.req.param('collection')!,
    c.req.param('slug'),
    input,
    authorId(requireActor(c)),
    c.req.query('locale'),
  )
  return c.json({ data })
})

app.delete('/:slug', requireSiteRole('editor'), requireScope('content:write'), async (c) => {
  await deleteEntry(
    c.env,
    requireSite(c),
    c.req.param('collection')!,
    c.req.param('slug'),
    c.req.query('locale'),
  )
  return c.body(null, 204)
})

app.get('/:slug/revisions', requireSiteRole('editor'), requireScope('content:read'), async (c) => {
  const data = await listEntryRevisions(
    c.env,
    requireSite(c),
    c.req.param('collection')!,
    c.req.param('slug'),
    c.req.query('locale'),
  )
  return c.json({ data })
})

app.post(
  '/:slug/revisions/:revisionId/restore',
  requireSiteRole('editor'),
  requireScope('content:write'),
  async (c) => {
    const data = await restoreEntryRevision(
      c.env,
      requireSite(c),
      c.req.param('collection')!,
      c.req.param('slug'),
      c.req.param('revisionId')!,
      authorId(requireActor(c)),
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

/**
 * Proposed future states of this entry — authoring, review and publish. Mounted here rather than at
 * the top level so a version is addressed through the entry it belongs to, and so the collection
 * and slug params resolve the same way for both.
 */
app.route('/:slug/versions', entryVersions)

/**
 * Mints a short-lived token that lets the website render this one entry unpublished, in its own
 * layout (`lib/preview.ts`).
 *
 * `viewer` because anyone who can already read the draft through the management API can already
 * read it — this endpoint changes *where* it can be read, not *who* may.
 *
 * `requireUserActor` is the load-bearing part, and it is a call rather than the usual middleware
 * because that is the shape the helper has. This prefix is in `KEY_MANAGED_PREFIXES`, so a
 * write-scoped API key resolves on it — and the whole requirement of authenticated preview is that
 * only a signed-in CMS user can produce a link to unpublished content. A key living in a website's
 * environment variables, or an MCP client acting on someone's behalf, must not be able to
 * manufacture one.
 */
app.post('/:slug/preview-token', requireSiteRole('viewer'), async (c) => {
  const actor = requireUserActor(c)
  const input = await validate(c, createPreviewTokenSchema)
  const data = await mintPreviewToken(
    c.env,
    requireSite(c),
    c.req.param('collection')!,
    c.req.param('slug'),
    input,
    actor.id,
  )
  return c.json({ data }, 201)
})

export default app
