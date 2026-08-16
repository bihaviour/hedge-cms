import {
  createNewsletterSchema,
  createSubscriberSchema,
  NEWSLETTER_AUDIENCES,
  testSendSchema,
  updateNewsletterSchema,
  updateSubscriberSchema,
} from '@hedge/core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Actor, AppEnv } from '../env'
import { requireActor, requireSitePermission } from '../lib/auth'
import {
  createNewsletter,
  createSubscriber,
  deleteNewsletter,
  deleteSubscriber,
  getNewsletter,
  listNewsletters,
  listSubscribers,
  resolveRecipients,
  sendNewsletter,
  sendTestNewsletter,
  updateNewsletter,
  updateSubscriber,
} from '../lib/newsletter'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'

const authorId = (actor: Actor) => (actor.kind === 'user' ? actor.id : null)

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})

/* ------------------------------------------------------------------ *
 * Subscribers — /api/v1/subscribers
 * ------------------------------------------------------------------ */

export const subscribers = new Hono<AppEnv>()

subscribers.get('/', requireSitePermission('subscribers:read'), async (c) => {
  const query = validateQuery(c, pageQuerySchema.extend({ q: z.string().max(200).optional() }))
  return c.json(await listSubscribers(c.env, requireSite(c).id, query))
})

subscribers.post('/', requireSitePermission('subscribers:create'), async (c) => {
  const input = await validate(c, createSubscriberSchema)
  return c.json({ data: await createSubscriber(c.env, requireSite(c).id, input) }, 201)
})

subscribers.patch('/:id', requireSitePermission('subscribers:update'), async (c) => {
  const input = await validate(c, updateSubscriberSchema)
  const data = await updateSubscriber(c.env, requireSite(c).id, c.req.param('id'), input)
  return c.json({ data })
})

subscribers.delete('/:id', requireSitePermission('subscribers:delete'), async (c) => {
  await deleteSubscriber(c.env, requireSite(c).id, c.req.param('id'))
  return c.body(null, 204)
})

/* ------------------------------------------------------------------ *
 * Newsletters — /api/v1/newsletters
 * ------------------------------------------------------------------ */

const app = new Hono<AppEnv>()

app.get('/', requireSitePermission('newsletters:read'), async (c) => {
  const query = validateQuery(c, pageQuerySchema)
  return c.json(await listNewsletters(c.env, requireSite(c).id, query))
})

/** The size of the audience a draft would reach right now — shown in the compose screen. */
app.get('/recipients/count', requireSitePermission('newsletters:read'), async (c) => {
  const { audience } = validateQuery(
    c,
    z.object({ audience: z.enum(NEWSLETTER_AUDIENCES).default('both') }),
  )
  const recipients = await resolveRecipients(c.env, requireSite(c).id, audience)
  return c.json({ data: { count: recipients.length } })
})

app.post('/', requireSitePermission('newsletters:create'), async (c) => {
  const input = await validate(c, createNewsletterSchema)
  const data = await createNewsletter(c.env, requireSite(c).id, input, authorId(requireActor(c)))
  return c.json({ data }, 201)
})

app.get('/:id', requireSitePermission('newsletters:read'), async (c) => {
  return c.json({ data: await getNewsletter(c.env, requireSite(c).id, c.req.param('id')) })
})

app.patch('/:id', requireSitePermission('newsletters:update'), async (c) => {
  const input = await validate(c, updateNewsletterSchema)
  const data = await updateNewsletter(c.env, requireSite(c).id, c.req.param('id'), input)
  return c.json({ data })
})

app.delete('/:id', requireSitePermission('newsletters:delete'), async (c) => {
  await deleteNewsletter(c.env, requireSite(c).id, c.req.param('id'))
  return c.body(null, 204)
})

app.post('/:id/test', requireSitePermission('newsletters:send'), async (c) => {
  const input = await validate(c, testSendSchema)
  await sendTestNewsletter(c.env, requireSite(c), c.req.param('id'), input.email)
  return c.json({ data: { ok: true } })
})

app.post('/:id/send', requireSitePermission('newsletters:send'), async (c) => {
  return c.json({ data: await sendNewsletter(c.env, requireSite(c), c.req.param('id')) })
})

export default app
