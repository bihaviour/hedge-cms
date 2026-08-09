import {
  createNewsletterTemplateSchema,
  newsletterPreviewInputSchema,
  updateNewsletterTemplateSchema,
} from '@hedge/core'
import { Hono } from 'hono'
import { resolveBrand } from '../email/config'
import { renderNewsletter } from '../email/render'
import type { AppEnv } from '../env'
import { requireActor, requireSiteRole } from '../lib/auth'
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

// Newsletter templates are audience content, so composing them is a site power like the newsletters
// they seed — the same `editor` gate the newsletter compose screen uses.
app.use('*', requireSiteRole('editor'))

app.get('/', async (c) => {
  return c.json({ data: await listNewsletterTemplates(c.env, requireSite(c).id) })
})

/** Renders a subject and body with the newsletter shell, for the editor's live preview. */
app.post('/preview', async (c) => {
  const input = await validate(c, newsletterPreviewInputSchema)
  // The site's brand, not the deployment's — a preview that renders a different name from the send
  // is a preview of something else.
  const message = renderNewsletter(resolveBrand(c.env, requireSite(c)), {
    subject: input.subject,
    body: input.body,
    unsubscribeUrl: `${c.env.PUBLIC_URL}/api/v1/newsletter/unsubscribe?preview=1`,
  })
  return c.json({ data: { subject: message.subject, html: message.html } })
})

app.post('/', async (c) => {
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

app.get('/:id', async (c) => {
  return c.json({ data: await getNewsletterTemplate(c.env, requireSite(c).id, c.req.param('id')) })
})

app.patch('/:id', async (c) => {
  const input = await validate(c, updateNewsletterTemplateSchema)
  const data = await updateNewsletterTemplate(c.env, requireSite(c).id, c.req.param('id'), input)
  return c.json({ data })
})

app.delete('/:id', async (c) => {
  await deleteNewsletterTemplate(c.env, requireSite(c).id, c.req.param('id'))
  return c.body(null, 204)
})

export default app
