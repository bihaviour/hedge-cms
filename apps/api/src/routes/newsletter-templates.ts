import {
  createNewsletterTemplateSchema,
  newsletterPreviewInputSchema,
  updateNewsletterTemplateSchema,
} from '@hedge/core'
import { Hono } from 'hono'
import { loadSenderIdentity, resolveBrand } from '../email/config'
import { renderNewsletter } from '../email/render'
import type { AppEnv } from '../env'
import { requireActor, requireSitePermission } from '../lib/auth'
import {
  createNewsletterTemplate,
  deleteNewsletterTemplate,
  getNewsletterTemplate,
  listNewsletterTemplates,
  updateNewsletterTemplate,
} from '../lib/newsletter'
import { requireSite } from '../lib/site'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

// Templates are part of the newsletters row of the matrix rather than an item of their own: they
// exist to be sent as newsletters and nobody has a different answer for the two (#151). The gate
// moved off the mount for the same reason it did on api-keys — reading and writing are two verbs.

app.get('/', requireSitePermission('newsletters:read'), async (c) => {
  return c.json({ data: await listNewsletterTemplates(c.env, requireSite(c).id) })
})

/** Renders a subject and body with the newsletter shell, for the editor's live preview. */
app.post('/preview', requireSitePermission('newsletters:read'), async (c) => {
  const input = await validate(c, newsletterPreviewInputSchema)
  const site = requireSite(c)
  // The newsletter brand, not the deployment's, honouring the draft's chosen sender (else the site's
  // newsletter sender) — a preview that renders a different name from the send is a preview of
  // something else (#136).
  const sender = await loadSenderIdentity(c.env, input.senderId ?? site.newsletterSenderId)
  const brand = resolveBrand(c.env, site, sender)
  const message = renderNewsletter(brand, {
    subject: input.subject,
    body: input.body,
    unsubscribeUrl: `${c.env.PUBLIC_URL}/api/v1/newsletter/unsubscribe?preview=1`,
  })
  return c.json({ data: { subject: message.subject, html: message.html } })
})

app.post('/', requireSitePermission('newsletters:create'), async (c) => {
  const input = await validate(c, createNewsletterTemplateSchema)
  const actor = requireActor(c)
  const data = await createNewsletterTemplate(
    c.env,
    requireSite(c).id,
    input,
    actor.kind === 'user' ? actor.id : null,
  )
  return c.json({ data }, 201)
})

app.get('/:id', requireSitePermission('newsletters:read'), async (c) => {
  return c.json({ data: await getNewsletterTemplate(c.env, requireSite(c).id, c.req.param('id')) })
})

app.patch('/:id', requireSitePermission('newsletters:update'), async (c) => {
  const input = await validate(c, updateNewsletterTemplateSchema)
  const data = await updateNewsletterTemplate(c.env, requireSite(c).id, c.req.param('id'), input)
  return c.json({ data })
})

app.delete('/:id', requireSitePermission('newsletters:delete'), async (c) => {
  await deleteNewsletterTemplate(c.env, requireSite(c).id, c.req.param('id'))
  return c.body(null, 204)
})

export default app
