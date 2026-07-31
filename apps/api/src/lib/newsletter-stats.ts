import type {
  AnalyticsRange,
  AudiencePoint,
  NewsletterAnalytics,
  NewsletterDelivery,
} from '@hedge/core'
import { and, count, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { getDb } from '../db/client'
import { emailLog, newsletterSubscribers, newsletters, type SiteRow } from '../db/schema'
import type { Bindings } from '../env'
import { eachDay } from './analytics'
import { ApiError } from './errors'

/**
 * Newsletter performance, entirely from rows the deployment already writes.
 *
 * Nothing here tracks anybody. `sendNewsletter` mails one recipient at a time and `sendEmail` logs
 * every attempt, `newsletters` records the audience size and send time, and `newsletter_subscribers`
 * records joins and unsubscribes — so sends, failures, growth and churn were in the database the
 * whole time and surfaced nowhere. The only thing that was missing is the link back to the campaign,
 * which `email_log.newsletterId` now carries.
 *
 * **Opens and clicks are deliberately absent.** Clicks would mean rewriting every link through a
 * redirect, opens a tracking pixel — and Apple Mail Privacy Protection prefetches images, so a
 * meaningful share of "opens" is Apple's proxy rather than a reader, inflated by an amount that
 * varies with audience and cannot be corrected. Both also mean per-recipient rows, which is the PII
 * question the rest of this feature avoids by being aggregate and cookieless. Adding either is a
 * decision to make on its merits, per site and off by default; it is not an oversight here.
 */

/** What the Email Sending binding actually tells us, mapped onto the log's own statuses. */
type LogStatus = 'sent' | 'failed' | 'skipped'

/**
 * Delivery counts for one campaign.
 *
 * `accepted` counts log rows whose status is `sent`, and `sent` means the binding accepted the
 * message — not that it reached an inbox. Cloudflare Email Sending surfaces no bounce or delivery
 * callback, so that is the ceiling of what can honestly be claimed, and the admin says "accepted"
 * rather than "delivered" for exactly that reason.
 */
export async function newsletterDelivery(
  env: Bindings,
  siteId: string,
  id: string,
): Promise<NewsletterDelivery> {
  const db = getDb(env)

  const [newsletter] = await db
    .select()
    .from(newsletters)
    .where(and(eq(newsletters.id, id), eq(newsletters.siteId, siteId)))
    .limit(1)

  if (!newsletter) throw ApiError.notFound('Newsletter')

  const byStatus = await db
    .select({ status: emailLog.status, total: count() })
    .from(emailLog)
    .where(eq(emailLog.newsletterId, newsletter.id))
    .groupBy(emailLog.status)

  const failures = await db
    .select({ reason: emailLog.error, total: count() })
    .from(emailLog)
    .where(and(eq(emailLog.newsletterId, newsletter.id), eq(emailLog.status, 'failed')))
    .groupBy(emailLog.error)
    .orderBy(desc(count()))
    .limit(10)

  const of = (status: LogStatus) => byStatus.find((row) => row.status === status)?.total ?? 0

  return {
    newsletterId: newsletter.id,
    subject: newsletter.subject,
    sentAt: newsletter.sentAt,
    recipientCount: newsletter.recipientCount,
    attempted: byStatus.reduce((total, row) => total + row.total, 0),
    accepted: of('sent'),
    failed: of('failed'),
    skipped: of('skipped'),
    failures: failures.map((row) => ({ reason: row.reason ?? 'Unknown', count: row.total })),
  }
}

/**
 * Subscribers gained and lost per day across a range, zero-filled.
 *
 * The interesting reading is not the totals but the shape: unsubscribes clustered on the day after a
 * send are attributable to that send, and that is the number that actually changes what somebody
 * writes next.
 */
async function audience(env: Bindings, siteId: string, from: string, to: string) {
  const db = getDb(env)

  // Timestamps are ISO strings, so the day is the first ten characters — comparable with the same
  // `YYYY-MM-DD` the rollups use, and indexable as a prefix range on the stored value.
  const day = (column: SQLiteColumn) => sql<string>`substr(${column}, 1, 10)`

  const [gained, lost] = await Promise.all([
    db
      .select({ date: day(newsletterSubscribers.createdAt), total: count() })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.siteId, siteId),
          gte(newsletterSubscribers.createdAt, from),
          lte(newsletterSubscribers.createdAt, `${to}T23:59:59.999Z`),
        ),
      )
      .groupBy(day(newsletterSubscribers.createdAt)),
    db
      .select({ date: day(newsletterSubscribers.unsubscribedAt), total: count() })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.siteId, siteId),
          isNotNull(newsletterSubscribers.unsubscribedAt),
          gte(newsletterSubscribers.unsubscribedAt, from),
          lte(newsletterSubscribers.unsubscribedAt, `${to}T23:59:59.999Z`),
        ),
      )
      .groupBy(day(newsletterSubscribers.unsubscribedAt)),
  ])

  const gainedByDay = new Map(gained.map((row) => [row.date, row.total]))
  const lostByDay = new Map(lost.map((row) => [row.date, row.total]))

  return eachDay(from, to).map<AudiencePoint>((date) => ({
    date,
    gained: gainedByDay.get(date) ?? 0,
    lost: lostByDay.get(date) ?? 0,
  }))
}

/** The newsletter section of `/analytics`: campaigns sent in the range, and how the list moved. */
export async function newsletterAnalytics(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
): Promise<NewsletterAnalytics> {
  const db = getDb(env)

  const sent = await db
    .select({ id: newsletters.id })
    .from(newsletters)
    .where(
      and(
        eq(newsletters.siteId, site.id),
        eq(newsletters.status, 'sent'),
        isNotNull(newsletters.sentAt),
        gte(newsletters.sentAt, range.from),
        lte(newsletters.sentAt, `${range.to}T23:59:59.999Z`),
      ),
    )
    .orderBy(desc(newsletters.sentAt))
    .limit(20)

  const [campaigns, points, [current], [before]] = await Promise.all([
    Promise.all(sent.map((row) => newsletterDelivery(env, site.id, row.id))),
    audience(env, site.id, range.from, range.to),
    db
      .select({ total: count() })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.siteId, site.id),
          eq(newsletterSubscribers.status, 'subscribed'),
        ),
      ),
    db
      .select({ total: count() })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.siteId, site.id),
          eq(newsletterSubscribers.status, 'subscribed'),
          lte(newsletterSubscribers.createdAt, `${range.previous.to}T23:59:59.999Z`),
        ),
      ),
  ])

  return {
    range,
    campaigns,
    audience: points,
    subscribers: { value: current?.total ?? 0, previous: before?.total ?? 0 },
  }
}
