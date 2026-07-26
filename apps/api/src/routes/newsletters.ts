import {
  createNewsletterSchema,
  createSubscriberSchema,
  NEWSLETTER_AUDIENCES,
  type Newsletter,
  type Subscriber,
  testSendSchema,
  updateNewsletterSchema,
  updateSubscriberSchema,
} from '@hedge/core'
import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import {
  type NewsletterRow,
  type NewsletterSubscriberRow,
  newsletterSubscribers,
  newsletters,
} from '../db/schema'
import { renderNewsletter } from '../email/render'
import { sendEmail } from '../email/send'
import type { AppEnv } from '../env'
import { requireActor, requireSiteRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { resolveRecipients, unsubscribeUrl } from '../lib/newsletter'
import { requireSite } from '../lib/site'
import { validate, validateQuery } from '../lib/validate'

/* ------------------------------------------------------------------ *
 * Subscribers — /api/v1/subscribers
 * ------------------------------------------------------------------ */

function toSubscriber(row: NewsletterSubscriberRow): Subscriber {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
    unsubscribedAt: row.unsubscribedAt,
  }
}

export const subscribers = new Hono<AppEnv>()

subscribers.get('/', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const query = validateQuery(
    c,
    z.object({
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
  )

  const filters: SQL[] = [eq(newsletterSubscribers.siteId, site.id)]
  if (query.q) filters.push(like(newsletterSubscribers.email, `%${query.q.toLowerCase()}%`))
  if (query.cursor) filters.push(lt(newsletterSubscribers.id, query.cursor))

  const rows = await getDb(c.env)
    .select()
    .from(newsletterSubscribers)
    .where(and(...filters))
    .orderBy(desc(newsletterSubscribers.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  return c.json({
    data: page.map(toSubscriber),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  })
})

subscribers.post('/', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, createSubscriberSchema)
  const db = getDb(c.env)
  const email = input.email.toLowerCase()

  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(and(eq(newsletterSubscribers.siteId, site.id), eq(newsletterSubscribers.email, email)))
    .limit(1)

  // A previously unsubscribed address is re-subscribed rather than duplicated; an active one is a
  // conflict so the operator knows the list already has them.
  if (existing) {
    if (existing.status === 'subscribed') {
      throw ApiError.conflict('That email is already subscribed')
    }
    const [row] = await db
      .update(newsletterSubscribers)
      .set({
        status: 'subscribed',
        unsubscribedAt: null,
        name: input.name ?? existing.name,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(newsletterSubscribers.id, existing.id))
      .returning()
    return c.json({ data: toSubscriber(row!) }, 201)
  }

  const [row] = await db
    .insert(newsletterSubscribers)
    .values({
      id: newId('nsub'),
      siteId: site.id,
      email,
      name: input.name ?? null,
      source: 'admin',
    })
    .returning()

  return c.json({ data: toSubscriber(row!) }, 201)
})

subscribers.patch('/:id', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, updateSubscriberSchema)
  const db = getDb(c.env)
  const id = c.req.param('id')

  const changes: Partial<NewsletterSubscriberRow> = { updatedAt: new Date().toISOString() }
  if (input.name !== undefined) changes.name = input.name
  if (input.status !== undefined) {
    changes.status = input.status
    changes.unsubscribedAt = input.status === 'unsubscribed' ? new Date().toISOString() : null
  }

  const [row] = await db
    .update(newsletterSubscribers)
    .set(changes)
    .where(and(eq(newsletterSubscribers.id, id), eq(newsletterSubscribers.siteId, site.id)))
    .returning()

  if (!row) throw ApiError.notFound('Subscriber')
  return c.json({ data: toSubscriber(row) })
})

subscribers.delete('/:id', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const [row] = await getDb(c.env)
    .delete(newsletterSubscribers)
    .where(
      and(
        eq(newsletterSubscribers.id, c.req.param('id')),
        eq(newsletterSubscribers.siteId, site.id),
      ),
    )
    .returning({ id: newsletterSubscribers.id })

  if (!row) throw ApiError.notFound('Subscriber')
  return c.body(null, 204)
})

/* ------------------------------------------------------------------ *
 * Newsletters — /api/v1/newsletters
 * ------------------------------------------------------------------ */

function toNewsletter(row: NewsletterRow): Newsletter {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    audience: row.audience,
    sentAt: row.sentAt,
    recipientCount: row.recipientCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const app = new Hono<AppEnv>()

app.get('/', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const query = validateQuery(
    c,
    z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
  )

  const filters: SQL[] = [eq(newsletters.siteId, site.id)]
  if (query.cursor) filters.push(lt(newsletters.id, query.cursor))

  const rows = await getDb(c.env)
    .select()
    .from(newsletters)
    .where(and(...filters))
    .orderBy(desc(newsletters.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  return c.json({
    data: page.map(toNewsletter),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  })
})

/** The size of the audience a draft would reach right now — shown in the compose screen. */
app.get('/recipients/count', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const { audience } = validateQuery(
    c,
    z.object({ audience: z.enum(NEWSLETTER_AUDIENCES).default('both') }),
  )
  const recipients = await resolveRecipients(c.env, site.id, audience)
  return c.json({ data: { count: recipients.length } })
})

app.post('/', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, createNewsletterSchema)
  const actor = requireActor(c)

  const [row] = await getDb(c.env)
    .insert(newsletters)
    .values({
      id: newId('news'),
      siteId: site.id,
      subject: input.subject,
      body: input.body,
      audience: input.audience,
      createdBy: actor.kind === 'user' ? actor.id : null,
    })
    .returning()

  return c.json({ data: toNewsletter(row!) }, 201)
})

app.get('/:id', requireSiteRole('editor'), async (c) => {
  const row = await ownedNewsletter(c)
  return c.json({ data: toNewsletter(row) })
})

app.patch('/:id', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, updateNewsletterSchema)
  const existing = await ownedNewsletter(c)

  // A sent newsletter is a record of what went out — editing it would make the log a lie.
  if (existing.status !== 'draft') {
    throw ApiError.badRequest('Only a draft newsletter can be edited')
  }

  const [row] = await getDb(c.env)
    .update(newsletters)
    .set({
      subject: input.subject ?? existing.subject,
      body: input.body ?? existing.body,
      audience: input.audience ?? existing.audience,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(newsletters.id, existing.id), eq(newsletters.siteId, site.id)))
    .returning()

  return c.json({ data: toNewsletter(row!) })
})

app.delete('/:id', requireSiteRole('editor'), async (c) => {
  const site = requireSite(c)
  const [row] = await getDb(c.env)
    .delete(newsletters)
    .where(and(eq(newsletters.id, c.req.param('id')), eq(newsletters.siteId, site.id)))
    .returning({ id: newsletters.id })

  if (!row) throw ApiError.notFound('Newsletter')
  return c.body(null, 204)
})

/** A single copy to one address, so an editor can see the real thing before sending to everyone. */
app.post('/:id/test', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const input = await validate(c, testSendSchema)
  const newsletter = await ownedNewsletter(c)

  const message = renderNewsletter(c.env.APP_NAME, {
    subject: `[Test] ${newsletter.subject}`,
    body: newsletter.body,
    unsubscribeUrl: `${c.env.PUBLIC_URL}/api/v1/newsletter/unsubscribe?test=1`,
  })
  // Sent as the site, so the test shows the sender the audience will actually see.
  await sendEmail(c.env, { ...message, to: input.email }, { site })

  return c.json({ data: { ok: true } })
})

/**
 * Sends the newsletter to its whole audience. Recipients are mailed one at a time, each with their
 * own unsubscribe link, and one bad address does not stop the rest. Large lists on Workers would
 * want a queue rather than an inline loop; this is bounded by what one request can send.
 */
app.post('/:id/send', requireSiteRole('admin'), async (c) => {
  const site = requireSite(c)
  const db = getDb(c.env)
  const newsletter = await ownedNewsletter(c)

  if (newsletter.status !== 'draft') {
    throw ApiError.badRequest('This newsletter has already been sent')
  }

  const recipients = await resolveRecipients(c.env, site.id, newsletter.audience)
  if (recipients.length === 0) {
    throw ApiError.badRequest('No subscribers to send to')
  }

  await db
    .update(newsletters)
    .set({ status: 'sending', updatedAt: new Date().toISOString() })
    .where(eq(newsletters.id, newsletter.id))

  let failed = 0
  for (const recipient of recipients) {
    try {
      const url = await unsubscribeUrl(c.env, site, recipient)
      const message = renderNewsletter(c.env.APP_NAME, {
        subject: newsletter.subject,
        body: newsletter.body,
        unsubscribeUrl: url,
      })
      await sendEmail(c.env, { ...message, to: recipient.email }, { site })
    } catch {
      failed++
    }
  }

  const now = new Date().toISOString()
  await db
    .update(newsletters)
    .set({ status: 'sent', sentAt: now, recipientCount: recipients.length, updatedAt: now })
    .where(eq(newsletters.id, newsletter.id))

  return c.json({ data: { recipientCount: recipients.length, failed } })
})

export default app

/** Loads a newsletter that belongs to the current site, or 404s. */
async function ownedNewsletter(c: Context<AppEnv>): Promise<NewsletterRow> {
  const site = requireSite(c)
  const id = c.req.param('id') ?? ''
  const [row] = await getDb(c.env)
    .select()
    .from(newsletters)
    .where(and(eq(newsletters.id, id), eq(newsletters.siteId, site.id)))
    .limit(1)
  if (!row) throw ApiError.notFound('Newsletter')
  return row
}
