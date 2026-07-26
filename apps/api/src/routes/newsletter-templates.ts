import {
  createNewsletterTemplateSchema,
  type NewsletterTemplate,
  newsletterPreviewInputSchema,
  updateNewsletterTemplateSchema,
} from '@hedge/core'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { type NewsletterTemplateRow, newsletterTemplates } from '../db/schema'
import { renderNewsletter } from '../email/render'
import type { AppEnv } from '../env'
import { requireActor, requireSiteRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

// Newsletter templates are audience content, so composing them is a site power like the newsletters
// they seed — the same `editor` gate the newsletter compose screen uses.
app.use('*', requireSiteRole('editor'))

function toTemplate(row: NewsletterTemplateRow): NewsletterTemplate {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

app.get('/', async (c) => {
  const site = requireSite(c)
  const rows = await getDb(c.env)
    .select()
    .from(newsletterTemplates)
    .where(eq(newsletterTemplates.siteId, site.id))
    .orderBy(desc(newsletterTemplates.id))
  return c.json({ data: rows.map(toTemplate) })
})

/** Renders a subject and body with the newsletter shell, for the editor's live preview. */
app.post('/preview', async (c) => {
  const input = await validate(c, newsletterPreviewInputSchema)
  const message = renderNewsletter(c.env.APP_NAME, {
    subject: input.subject,
    body: input.body,
    unsubscribeUrl: `${c.env.PUBLIC_URL}/api/v1/newsletter/unsubscribe?preview=1`,
  })
  return c.json({ data: { subject: message.subject, html: message.html } })
})

app.post('/', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, createNewsletterTemplateSchema)
  const actor = requireActor(c)

  const [row] = await getDb(c.env)
    .insert(newsletterTemplates)
    .values({
      id: newId('ntpl'),
      siteId: site.id,
      name: input.name,
      subject: input.subject,
      body: input.body,
      createdBy: actor.kind === 'user' ? actor.id : null,
    })
    .returning()

  return c.json({ data: toTemplate(row!) }, 201)
})

app.get('/:id', async (c) => {
  const site = requireSite(c)
  const [row] = await getDb(c.env)
    .select()
    .from(newsletterTemplates)
    .where(
      and(eq(newsletterTemplates.id, c.req.param('id')), eq(newsletterTemplates.siteId, site.id)),
    )
    .limit(1)
  if (!row) throw ApiError.notFound('Newsletter template')
  return c.json({ data: toTemplate(row) })
})

app.patch('/:id', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, updateNewsletterTemplateSchema)

  const [row] = await getDb(c.env)
    .update(newsletterTemplates)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(
      and(eq(newsletterTemplates.id, c.req.param('id')), eq(newsletterTemplates.siteId, site.id)),
    )
    .returning()

  if (!row) throw ApiError.notFound('Newsletter template')
  return c.json({ data: toTemplate(row) })
})

app.delete('/:id', async (c) => {
  const site = requireSite(c)
  const [row] = await getDb(c.env)
    .delete(newsletterTemplates)
    .where(
      and(eq(newsletterTemplates.id, c.req.param('id')), eq(newsletterTemplates.siteId, site.id)),
    )
    .returning({ id: newsletterTemplates.id })

  if (!row) throw ApiError.notFound('Newsletter template')
  return c.body(null, 204)
})

export default app
