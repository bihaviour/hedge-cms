import type {
  CreateNewsletterInput,
  CreateNewsletterTemplateInput,
  CreateSubscriberInput,
  Newsletter,
  NewsletterAudience,
  NewsletterTemplate,
  Paginated,
  SendResult,
  Subscriber,
  UpdateNewsletterInput,
  UpdateNewsletterTemplateInput,
  UpdateSubscriberInput,
} from '@hedge/core'
import { and, count, desc, eq, like, lt, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import {
  memberSites,
  members,
  type NewsletterRow,
  type NewsletterSubscriberRow,
  type NewsletterTemplateRow,
  newsletterSubscribers,
  newsletters,
  newsletterTemplates,
  type SiteRow,
} from '../db/schema'
import { resolveBrand, type SenderOverride } from '../email/config'
import { renderNewsletter } from '../email/render'
import { sendEmail } from '../email/send'
import type { Bindings } from '../env'
import { hmac, timingSafeEqualString } from './crypto'
import { ApiError } from './errors'
import { newId } from './id'

/** Who an unsubscribe link belongs to — a list subscriber, or a member's per-site newsletter opt-in. */
export type RecipientKind = 'subscriber' | 'member'

export interface Recipient {
  kind: RecipientKind
  id: string
  email: string
  name: string | null
}

/**
 * The unsubscribe token. Keyed on `AUTH_SECRET` and bound to the kind, site and id, so a link works
 * only for the exact recipient it was minted for and cannot be forged or pointed at another row.
 */
export function unsubscribeToken(
  env: Bindings,
  kind: RecipientKind,
  siteId: string,
  id: string,
): Promise<string> {
  return hmac(env.AUTH_SECRET, `unsub:${kind}:${siteId}:${id}`)
}

export async function verifyUnsubscribeToken(
  env: Bindings,
  kind: RecipientKind,
  siteId: string,
  id: string,
  token: string,
): Promise<boolean> {
  return timingSafeEqualString(token, await unsubscribeToken(env, kind, siteId, id))
}

export async function unsubscribeUrl(
  env: Bindings,
  site: SiteRow,
  recipient: Recipient,
): Promise<string> {
  const token = await unsubscribeToken(env, recipient.kind, site.id, recipient.id)
  const params = new URLSearchParams({
    site: site.id,
    kind: recipient.kind,
    id: recipient.id,
    token,
  })
  return `${env.PUBLIC_URL}/api/v1/newsletter/unsubscribe?${params}`
}

/**
 * The addresses a newsletter goes to, deduplicated by email. Subscribers come first, then members
 * whose per-site newsletter opt-in is still set and who are not blocked — a member who also appears
 * on the subscriber list is only mailed once.
 */
export async function resolveRecipients(
  env: Bindings,
  siteId: string,
  audience: NewsletterAudience,
): Promise<Recipient[]> {
  const db = getDb(env)
  const recipients: Recipient[] = []
  const seen = new Set<string>()

  if (audience === 'subscribers' || audience === 'both') {
    const rows = await db
      .select()
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.siteId, siteId),
          eq(newsletterSubscribers.status, 'subscribed'),
        ),
      )
    for (const row of rows) {
      const email = row.email.toLowerCase()
      if (seen.has(email)) continue
      seen.add(email)
      recipients.push({ kind: 'subscriber', id: row.id, email: row.email, name: row.name })
    }
  }

  if (audience === 'members' || audience === 'both') {
    const rows = await db
      .select({ id: members.id, email: members.email, name: members.name })
      .from(memberSites)
      .innerJoin(members, eq(members.id, memberSites.memberId))
      .where(
        and(
          eq(memberSites.siteId, siteId),
          eq(memberSites.status, 'active'),
          eq(memberSites.newsletterSubscribed, true),
        ),
      )
    for (const row of rows) {
      const email = row.email.toLowerCase()
      if (seen.has(email)) continue
      seen.add(email)
      recipients.push({ kind: 'member', id: row.id, email: row.email, name: row.name })
    }
  }

  return recipients
}

/* ------------------------------------------------------------------ *
 * Subscribers, campaigns and templates — factored out of the HTTP routes so the REST API and the
 * MCP endpoint drive the same logic. Everything here is scoped to one `siteId`: the newsletter
 * tables are tenant-owned, and a query that forgets that is a cross-site leak.
 * ------------------------------------------------------------------ */

export function toSubscriber(row: NewsletterSubscriberRow): Subscriber {
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

export async function listSubscribers(
  env: Bindings,
  siteId: string,
  options: { q?: string; limit: number; cursor?: string },
): Promise<Paginated<Subscriber>> {
  const filters: SQL[] = [eq(newsletterSubscribers.siteId, siteId)]
  if (options.q) filters.push(like(newsletterSubscribers.email, `%${options.q.toLowerCase()}%`))

  // The cursor narrows the page, not the count — see `listEntries` for why they are kept apart.
  const pageFilters = options.cursor
    ? [...filters, lt(newsletterSubscribers.id, options.cursor)]
    : filters

  const db = getDb(env)
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(newsletterSubscribers)
      .where(and(...pageFilters))
      .orderBy(desc(newsletterSubscribers.id))
      .limit(options.limit + 1),
    db
      .select({ value: count() })
      .from(newsletterSubscribers)
      .where(and(...filters)),
  ])

  const hasMore = rows.length > options.limit
  const page = hasMore ? rows.slice(0, options.limit) : rows

  return {
    data: page.map(toSubscriber),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    total: counted?.value ?? 0,
  }
}

export async function createSubscriber(
  env: Bindings,
  siteId: string,
  input: CreateSubscriberInput,
  source = 'admin',
): Promise<Subscriber> {
  const db = getDb(env)
  const email = input.email.toLowerCase()

  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(and(eq(newsletterSubscribers.siteId, siteId), eq(newsletterSubscribers.email, email)))
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
    return toSubscriber(row!)
  }

  const [row] = await db
    .insert(newsletterSubscribers)
    .values({
      id: newId('nsub'),
      siteId,
      email,
      name: input.name ?? null,
      source,
    })
    .returning()

  return toSubscriber(row!)
}

export async function updateSubscriber(
  env: Bindings,
  siteId: string,
  id: string,
  input: UpdateSubscriberInput,
): Promise<Subscriber> {
  const changes: Partial<NewsletterSubscriberRow> = { updatedAt: new Date().toISOString() }
  if (input.name !== undefined) changes.name = input.name
  if (input.status !== undefined) {
    changes.status = input.status
    changes.unsubscribedAt = input.status === 'unsubscribed' ? new Date().toISOString() : null
  }

  const [row] = await getDb(env)
    .update(newsletterSubscribers)
    .set(changes)
    .where(and(eq(newsletterSubscribers.id, id), eq(newsletterSubscribers.siteId, siteId)))
    .returning()

  if (!row) throw ApiError.notFound('Subscriber')
  return toSubscriber(row)
}

export async function deleteSubscriber(env: Bindings, siteId: string, id: string): Promise<void> {
  const [row] = await getDb(env)
    .delete(newsletterSubscribers)
    .where(and(eq(newsletterSubscribers.id, id), eq(newsletterSubscribers.siteId, siteId)))
    .returning({ id: newsletterSubscribers.id })

  if (!row) throw ApiError.notFound('Subscriber')
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

export function toTemplate(row: NewsletterTemplateRow): NewsletterTemplate {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listNewsletterTemplates(
  env: Bindings,
  siteId: string,
): Promise<NewsletterTemplate[]> {
  const rows = await getDb(env)
    .select()
    .from(newsletterTemplates)
    .where(eq(newsletterTemplates.siteId, siteId))
    .orderBy(desc(newsletterTemplates.id))
  return rows.map(toTemplate)
}

export async function getNewsletterTemplate(
  env: Bindings,
  siteId: string,
  id: string,
): Promise<NewsletterTemplate> {
  const [row] = await getDb(env)
    .select()
    .from(newsletterTemplates)
    .where(and(eq(newsletterTemplates.id, id), eq(newsletterTemplates.siteId, siteId)))
    .limit(1)

  if (!row) throw ApiError.notFound('Newsletter template')
  return toTemplate(row)
}

export async function createNewsletterTemplate(
  env: Bindings,
  siteId: string,
  input: CreateNewsletterTemplateInput,
  actorId: string | null,
): Promise<NewsletterTemplate> {
  const [row] = await getDb(env)
    .insert(newsletterTemplates)
    .values({
      id: newId('ntpl'),
      siteId,
      name: input.name,
      subject: input.subject,
      body: input.body,
      createdBy: actorId,
    })
    .returning()

  return toTemplate(row!)
}

export async function updateNewsletterTemplate(
  env: Bindings,
  siteId: string,
  id: string,
  input: UpdateNewsletterTemplateInput,
): Promise<NewsletterTemplate> {
  const [row] = await getDb(env)
    .update(newsletterTemplates)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(and(eq(newsletterTemplates.id, id), eq(newsletterTemplates.siteId, siteId)))
    .returning()

  if (!row) throw ApiError.notFound('Newsletter template')
  return toTemplate(row)
}

export async function deleteNewsletterTemplate(
  env: Bindings,
  siteId: string,
  id: string,
): Promise<void> {
  const [row] = await getDb(env)
    .delete(newsletterTemplates)
    .where(and(eq(newsletterTemplates.id, id), eq(newsletterTemplates.siteId, siteId)))
    .returning({ id: newsletterTemplates.id })

  if (!row) throw ApiError.notFound('Newsletter template')
}

/* ------------------------------------------------------------------ *
 * Campaigns
 * ------------------------------------------------------------------ */

export function toNewsletter(row: NewsletterRow): Newsletter {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    audience: row.audience,
    // The stored override, nulls and all — the compose form shows exactly what was set (#134).
    sender: { fromEmail: row.fromEmail, fromName: row.fromName, replyTo: row.replyTo },
    sentAt: row.sentAt,
    recipientCount: row.recipientCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Loads a newsletter that belongs to this site, or 404s. */
export async function findNewsletter(
  env: Bindings,
  siteId: string,
  id: string,
): Promise<NewsletterRow> {
  const [row] = await getDb(env)
    .select()
    .from(newsletters)
    .where(and(eq(newsletters.id, id), eq(newsletters.siteId, siteId)))
    .limit(1)

  if (!row) throw ApiError.notFound('Newsletter')
  return row
}

export async function listNewsletters(
  env: Bindings,
  siteId: string,
  options: { limit: number; cursor?: string },
): Promise<Paginated<Newsletter>> {
  const filters: SQL[] = [eq(newsletters.siteId, siteId)]

  // The cursor narrows the page, not the count — see `listEntries` for why they are kept apart.
  const pageFilters = options.cursor ? [...filters, lt(newsletters.id, options.cursor)] : filters

  const db = getDb(env)
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(newsletters)
      .where(and(...pageFilters))
      .orderBy(desc(newsletters.id))
      .limit(options.limit + 1),
    db
      .select({ value: count() })
      .from(newsletters)
      .where(and(...filters)),
  ])

  const hasMore = rows.length > options.limit
  const page = hasMore ? rows.slice(0, options.limit) : rows

  return {
    data: page.map(toNewsletter),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    total: counted?.value ?? 0,
  }
}

export async function getNewsletter(
  env: Bindings,
  siteId: string,
  id: string,
): Promise<Newsletter> {
  return toNewsletter(await findNewsletter(env, siteId, id))
}

export async function createNewsletter(
  env: Bindings,
  siteId: string,
  input: CreateNewsletterInput,
  actorId: string | null,
): Promise<Newsletter> {
  const [row] = await getDb(env)
    .insert(newsletters)
    .values({
      id: newId('news'),
      siteId,
      subject: input.subject,
      body: input.body,
      audience: input.audience,
      // Null on each field when no override was sent — the campaign inherits the site's newsletter
      // sender (#134).
      fromEmail: input.sender?.fromEmail ?? null,
      fromName: input.sender?.fromName ?? null,
      replyTo: input.sender?.replyTo ?? null,
      createdBy: actorId,
    })
    .returning()

  return toNewsletter(row!)
}

export async function updateNewsletter(
  env: Bindings,
  siteId: string,
  id: string,
  input: UpdateNewsletterInput,
): Promise<Newsletter> {
  const existing = await findNewsletter(env, siteId, id)

  // A sent newsletter is a record of what went out — editing it would make the log a lie.
  if (existing.status !== 'draft') {
    throw ApiError.badRequest('Only a draft newsletter can be edited')
  }

  const [row] = await getDb(env)
    .update(newsletters)
    .set({
      subject: input.subject ?? existing.subject,
      body: input.body ?? existing.body,
      audience: input.audience ?? existing.audience,
      // All three move together, so a cleared override is a null the caller sent; omitting `sender`
      // leaves the stored one untouched (#134).
      ...(input.sender !== undefined
        ? {
            fromEmail: input.sender.fromEmail,
            fromName: input.sender.fromName,
            replyTo: input.sender.replyTo,
          }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(newsletters.id, existing.id), eq(newsletters.siteId, siteId)))
    .returning()

  return toNewsletter(row!)
}

export async function deleteNewsletter(env: Bindings, siteId: string, id: string): Promise<void> {
  const [row] = await getDb(env)
    .delete(newsletters)
    .where(and(eq(newsletters.id, id), eq(newsletters.siteId, siteId)))
    .returning({ id: newsletters.id })

  if (!row) throw ApiError.notFound('Newsletter')
}

/** A single copy to one address, so an editor can see the real thing before sending to everyone. */
export async function sendTestNewsletter(
  env: Bindings,
  site: SiteRow,
  id: string,
  email: string,
): Promise<void> {
  const newsletter = await findNewsletter(env, site.id, id)
  const senderOverride = campaignSender(newsletter)

  const message = renderNewsletter(resolveBrand(env, site, 'newsletter', senderOverride), {
    subject: `[Test] ${newsletter.subject}`,
    body: newsletter.body,
    unsubscribeUrl: `${env.PUBLIC_URL}/api/v1/newsletter/unsubscribe?test=1`,
  })
  // Sent as the newsletter's own sender, so the test shows exactly what the audience will see.
  await sendEmail(env, { ...message, to: email }, { site, purpose: 'newsletter', senderOverride })
}

/** A newsletter row's stored sender override, in the shape `resolveSender` takes (#134). */
function campaignSender(row: NewsletterRow): SenderOverride {
  return { fromEmail: row.fromEmail, fromName: row.fromName, replyTo: row.replyTo }
}

/**
 * Sends the newsletter to its whole audience. Recipients are mailed one at a time, each with their
 * own unsubscribe link, and one bad address does not stop the rest. Large lists on Workers would
 * want a queue rather than an inline loop; this is bounded by what one request can send.
 */
export async function sendNewsletter(
  env: Bindings,
  site: SiteRow,
  id: string,
): Promise<SendResult> {
  const db = getDb(env)
  const newsletter = await findNewsletter(env, site.id, id)

  if (newsletter.status !== 'draft') {
    throw ApiError.badRequest('This newsletter has already been sent')
  }

  const recipients = await resolveRecipients(env, site.id, newsletter.audience)
  if (recipients.length === 0) {
    throw ApiError.badRequest('No subscribers to send to')
  }

  await db
    .update(newsletters)
    .set({ status: 'sending', updatedAt: new Date().toISOString() })
    .where(eq(newsletters.id, newsletter.id))

  // Resolved once, outside the loop: both are the same for every recipient and this is the one send
  // path that runs per address. The override is the campaign's own sender (#134).
  const senderOverride = campaignSender(newsletter)
  const brand = resolveBrand(env, site, 'newsletter', senderOverride)

  let failed = 0
  for (const recipient of recipients) {
    try {
      const url = await unsubscribeUrl(env, site, recipient)
      const message = renderNewsletter(brand, {
        subject: newsletter.subject,
        body: newsletter.body,
        unsubscribeUrl: url,
      })
      // The campaign id is what makes per-campaign delivery a query rather than a subject-line
      // guess — see `lib/newsletter-stats.ts`.
      await sendEmail(
        env,
        { ...message, to: recipient.email },
        { site, purpose: 'newsletter', senderOverride, newsletterId: newsletter.id },
      )
    } catch {
      failed++
    }
  }

  const now = new Date().toISOString()
  await db
    .update(newsletters)
    .set({ status: 'sent', sentAt: now, recipientCount: recipients.length, updatedAt: now })
    .where(eq(newsletters.id, newsletter.id))

  return { recipientCount: recipients.length, failed }
}
