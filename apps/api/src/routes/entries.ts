import {
  attachTranslationSchema,
  createEntrySchema,
  createPreviewTokenSchema,
  listEntriesQuerySchema,
  updateEntrySchema,
} from '@hedge/core'
import { Hono } from 'hono'
import type { Actor, AppEnv } from '../env'
import { requireActor, requireScope, requireSitePermission, requireUserActor } from '../lib/auth'
import {
  attachTranslation,
  createEntry,
  deleteEntry,
  detachTranslation,
  getEntry,
  listEntries,
  listEntryRevisions,
  listTranslations,
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

app.get('/', requireSitePermission('entries:read'), requireScope('content:read'), async (c) => {
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

app.get(
  '/:slug',
  requireSitePermission('entries:read'),
  requireScope('content:read'),
  async (c) => {
    const data = await getEntry(
      c.env,
      requireSite(c),
      c.req.param('collection')!,
      c.req.param('slug'),
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

app.post('/', requireSitePermission('entries:create'), requireScope('content:write'), async (c) => {
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

app.patch(
  '/:slug',
  requireSitePermission('entries:update'),
  requireScope('content:write'),
  async (c) => {
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
  },
)

app.delete(
  '/:slug',
  requireSitePermission('entries:delete'),
  requireScope('content:write'),
  async (c) => {
    await deleteEntry(
      c.env,
      requireSite(c),
      c.req.param('collection')!,
      c.req.param('slug'),
      c.req.query('locale'),
    )
    return c.body(null, 204)
  },
)

app.get(
  '/:slug/revisions',
  requireSitePermission('entries:read'),
  requireScope('content:read'),
  async (c) => {
    const data = await listEntryRevisions(
      c.env,
      requireSite(c),
      c.req.param('collection')!,
      c.req.param('slug'),
      c.req.query('locale'),
    )
    return c.json({ data })
  },
)

app.post(
  '/:slug/revisions/:revisionId/restore',
  requireSitePermission('entries:update'),
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
 * The other languages of this entry, and the two operations that change which post a row belongs to.
 *
 * `content:write` and `editor` rather than anything narrower: linking two entries is an ordinary
 * editorial act on content, and it changes no text, no status and no URL — it only records that two
 * rows are the same piece. Notably *not* `requireUserActor`: unlike approving a version, there is
 * nothing here that has to be a human judgement rather than an automated one, and an agent tidying
 * up a batch of imported translations is a good use of it.
 */
app.get(
  '/:slug/translations',
  requireSitePermission('entries:read'),
  requireScope('content:read'),
  async (c) => {
    // No `?locale=`: a slug names one post whichever language it is written in, and the admin asks
    // this while looking at a language the post may not have yet.
    const data = await listTranslations(
      c.env,
      requireSite(c),
      c.req.param('collection')!,
      c.req.param('slug'),
    )
    return c.json({ data })
  },
)

app.post(
  '/:slug/translations',
  requireSitePermission('entries:update'),
  requireScope('content:write'),
  async (c) => {
    const input = await validate(c, attachTranslationSchema)
    const data = await attachTranslation(
      c.env,
      requireSite(c),
      c.req.param('collection')!,
      c.req.param('slug'),
      input,
    )
    return c.json({ data })
  },
)

/**
 * Splits one language out into a post of its own. The locale is a path segment rather than the
 * usual `?locale=` because here it is *what is being removed*, not which copy to load — the
 * addressed entry and the detached one are the same row, and a query parameter that meant both
 * would be the kind of ambiguity that gets read wrong once and never noticed.
 */
app.delete(
  '/:slug/translations/:locale',
  requireSitePermission('entries:update'),
  requireScope('content:write'),
  async (c) => {
    const data = await detachTranslation(
      c.env,
      requireSite(c),
      c.req.param('collection')!,
      c.req.param('slug'),
      c.req.param('locale'),
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
app.post('/:slug/preview-token', requireSitePermission('entries:read'), async (c) => {
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
