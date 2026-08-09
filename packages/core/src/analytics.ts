import { z } from 'zod'

/**
 * Website analytics — the shapes the collector accepts and the reporting API returns.
 *
 * The thing to hold on to while reading this file: **the Worker does not see website traffic.** A
 * reader's browser talks to the website, not to this deployment, and the website's own delivery API
 * calls are absorbed by Cloudflare's cache (`s-maxage` in `routes/content.ts`). One delivery request
 * can serve a month of readers under static generation, so delivery request counts are not pageviews
 * and the factor between them is unknowable. Everything here is therefore fed by a first-party
 * beacon the website sends, or it is not measured at all.
 */

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

/** Where the Worker serves the beacon script and where the beacon posts. */
export const ANALYTICS_SCRIPT_PATH = '/api/v1/collect/script.js'
export const ANALYTICS_COLLECT_PATH = '/api/v1/collect'

/**
 * What a *client* is allowed to report. `referral` is deliberately not in this list even though it
 * is a stored metric: a referral is derived server-side from the `Referer`-like value on a view, so
 * nobody can claim inbound traffic that never landed on a page. See `ANALYTICS_METRICS`.
 */
export const COLLECT_EVENTS = ['view', 'share_intent'] as const
export type CollectEvent = (typeof COLLECT_EVENTS)[number]

/**
 * One beacon. Sent with `navigator.sendBeacon`, so nothing ever reads the response — which is why
 * the endpoint answers `204` to everything, valid or not.
 */
export const collectEventSchema = z.object({
  /** Path only, no origin. Query and hash are stripped server-side before it becomes a bucket. */
  path: z.string().min(1).max(512),
  event: z.enum(COLLECT_EVENTS).default('view'),
  /** The full referrer as the browser reported it. Reduced to a bare host before storage. */
  referrer: z.string().max(2048).optional(),
  /**
   * For `share_intent`: which control the reader clicked — `x`, `linkedin`, `copy`, … Free text so
   * a website can name its own, capped and lowercased before it becomes a dimension.
   */
  target: z.string().max(40).optional(),
})

export type CollectEventInput = z.infer<typeof collectEventSchema>

/* ------------------------------------------------------------------ *
 * Storage shape
 * ------------------------------------------------------------------ */

/**
 * The metrics a rollup bucket can hold.
 *
 * - `view` — one pageview, keyed by path (and the entry that path resolved to)
 * - `share_intent` — a click on the website's *own* share control, keyed by target. No platform
 *   reports share counts any more, so this is share *intent* and must never be labelled "shares on X"
 * - `referral` — an inbound visit from another host, keyed by that host, recorded site-wide
 */
export const ANALYTICS_METRICS = ['view', 'share_intent', 'referral'] as const
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number]

/**
 * How long rollups are kept. 400 days rather than 365 so a year-over-year comparison still has the
 * far end of its range — a whole year of retention makes "this time last year" the first row to
 * disappear. Enforced by the daily cron in `apps/api/src/index.ts`.
 */
export const ANALYTICS_RETENTION_DAYS = 400

/**
 * Caps on how many distinct values one site can create in one day, per dimension. This is what makes
 * "bounded by construction" true rather than aspirational: the collector is a public write path, and
 * without these a script posting a million invented paths is a million rows. Overflow is folded into
 * `ANALYTICS_OTHER`, so the traffic is still counted, just not itemised.
 */
export const ANALYTICS_MAX_PATHS_PER_DAY = 500
export const ANALYTICS_MAX_REFERRERS_PER_DAY = 100
export const ANALYTICS_MAX_SHARE_TARGETS_PER_DAY = 25

/** Where everything above the cap lands. Not a valid path or host, so it cannot collide with one. */
export const ANALYTICS_OTHER = '(other)'

/** A referral row's key when the browser sent no referrer at all — see the note in `analytics.tsx`. */
export const ANALYTICS_DIRECT = '(direct)'

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/** The longest range the reporting API will scan. Wider is a 400, not a table scan. */
export const ANALYTICS_MAX_RANGE_DAYS = 400
export const ANALYTICS_DEFAULT_RANGE_DAYS = 30

/** `YYYY-MM-DD`, resolved in the *site's* timezone — see `dayInTimezone` in the Worker. */
export const analyticsDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')

/**
 * `days` is what the admin's range picker actually sends.
 *
 * "The last 30 days" cannot be turned into two dates without knowing where the site's day ends, and
 * the browser does not — its clock is the viewer's, not the site's. Sending the intent and letting
 * the server cut the days is what keeps the dashboard and the detail page from quietly disagreeing
 * about what "today" is. `from`/`to` stay available for an explicit window.
 */
export const analyticsRangeSchema = z.object({
  from: analyticsDateSchema.optional(),
  to: analyticsDateSchema.optional(),
  days: z.coerce.number().int().min(1).max(400).optional(),
})

/** The presets the admin offers. Anything else is a hand-written `from`/`to`. */
export const ANALYTICS_RANGE_PRESETS = [7, 30, 90, 365] as const

export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeSchema>

/** The resolved range, echoed back so the admin never re-derives day boundaries of its own. */
export interface AnalyticsRange {
  from: string
  to: string
  /** The IANA timezone the days were cut in — the site's. */
  timezone: string
  /** The equal-length window immediately before `from`, which every total is compared against. */
  previous: { from: string; to: string }
  /**
   * The earliest day this site has any rollup for, or null when it has none. The detail page uses it
   * to say "data starts on…" instead of drawing a chart that appears to show traffic collapsing on
   * the day the script was switched on.
   */
  firstDay: string | null
}

/** One day of one metric. Days with no traffic are filled with zeroes rather than omitted. */
export interface AnalyticsPoint {
  date: string
  count: number
}

/** A total with the same total from the previous window beside it. A number alone is decoration. */
export interface AnalyticsTotal {
  value: number
  previous: number
}

export interface AnalyticsOverview {
  range: AnalyticsRange
  views: AnalyticsTotal
  shareIntents: AnalyticsTotal
  referrals: AnalyticsTotal
  /** Distinct paths that were viewed at least once — "how much of the site was read". */
  pages: AnalyticsTotal
  /** Daily views across `range`, zero-filled, for the sparkline. */
  series: AnalyticsPoint[]
}

export interface AnalyticsTimeseries {
  range: AnalyticsRange
  metric: AnalyticsMetric
  series: AnalyticsPoint[]
  /** The same metric over `range.previous`, aligned to the same length for a comparison line. */
  previousSeries: AnalyticsPoint[]
}

/** One row of the ranked article table. `entryId` is null for a path that matches no entry. */
export interface AnalyticsEntryStat {
  entryId: string | null
  path: string
  /** Resolved from the entry's `data.title` when there is an entry; otherwise just the path. */
  title: string
  collectionSlug: string | null
  slug: string | null
  locale: string | null
  views: number
  previousViews: number
  shareIntents: number
}

/**
 * One entry's totals over a window, addressed by the entry rather than by a path.
 *
 * Deliberately not `AnalyticsEntryStat`: that one is a *ranked path*, truncated to a top-N, and a
 * table of content the reader is already looking at cannot be fed from a ranking — an article on
 * page four of a collection is not in the top ten of anything and still has to show its own number.
 * So this is asked for by collection and answered per entry, with no ordering and no truncation.
 *
 * Only entries with traffic in the window appear. An entry missing from the list has no rollup, not
 * a zero somebody forgot to send, and the two are the same thing to read: nothing was recorded.
 */
export interface AnalyticsEntryTotals {
  entryId: string
  views: number
  previousViews: number
  shareIntents: number
}

/**
 * The window the per-entry columns in a collection's entries table cover.
 *
 * Fixed rather than picked, because that table is a list of content with traffic beside it, not an
 * analytics screen — the range picker lives on `/analytics`, and a second one here would be two
 * controls disagreeing about what period the numbers describe. The column caption names the window
 * so the figures are never read as all-time.
 */
export const ANALYTICS_ENTRY_COLUMN_DAYS = 30

/** A referrer host, with the coarse group the UI presents it under. */
export const REFERRER_GROUPS = ['search', 'social', 'direct', 'other'] as const
export type ReferrerGroup = (typeof REFERRER_GROUPS)[number]

export interface AnalyticsReferrerStat {
  host: string
  group: ReferrerGroup
  count: number
  previousCount: number
}

export interface AnalyticsShareStat {
  target: string
  count: number
  previousCount: number
}

/* ------------------------------------------------------------------ *
 * Newsletter performance
 *
 * Independent of everything above: it needs no collector and no beacon, only the rows the send path
 * already writes. See issue #74.
 * ------------------------------------------------------------------ */

/**
 * Delivery for one campaign, counted from `email_log`.
 *
 * `delivered` is the honest ceiling of what the Cloudflare Email Sending binding tells us: it
 * reports that a message was *accepted*, not that it reached an inbox, and there is no bounce or
 * delivery webhook to reconcile against. The UI says "accepted", and so should anything else that
 * reads this.
 */
export interface NewsletterDelivery {
  newsletterId: string
  subject: string
  sentAt: string | null
  /** From `newsletters.recipientCount` — the audience size resolved at send time. */
  recipientCount: number | null
  attempted: number
  accepted: number
  failed: number
  skipped: number
  /** The distinct failure reasons already stored on the log rows, most common first. */
  failures: { reason: string; count: number }[]
}

/** Subscribers gained and lost on one day, from `createdAt` and `unsubscribedAt`. */
export interface AudiencePoint {
  date: string
  gained: number
  lost: number
}

export interface NewsletterAnalytics {
  range: AnalyticsRange
  /** Campaigns sent inside the range, newest first, with their delivery counts. */
  campaigns: NewsletterDelivery[]
  audience: AudiencePoint[]
  /** Subscribers currently on the list, and how that changed across the range. */
  subscribers: AnalyticsTotal
}
