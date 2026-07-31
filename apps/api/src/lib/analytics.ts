import {
  ANALYTICS_DIRECT,
  ANALYTICS_MAX_PATHS_PER_DAY,
  ANALYTICS_MAX_REFERRERS_PER_DAY,
  ANALYTICS_MAX_SHARE_TARGETS_PER_DAY,
  ANALYTICS_OTHER,
  ANALYTICS_RETENTION_DAYS,
  type AnalyticsMetric,
  type CollectEventInput,
} from '@hedge/core'
import { and, countDistinct, eq, lt, ne, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { analyticsDaily, collections, entries, type SiteRow } from '../db/schema'
import type { Bindings } from '../env'
import { newId } from './id'

/**
 * The write side of website analytics: turning one beacon into one incremented counter, and keeping
 * the table from growing without bound while doing it.
 *
 * Nothing here throws. The collector is a public endpoint a website calls during a render, and a
 * website must never break because analytics failed — the route answers `204` either way, so a
 * failure here is a lost count, which is the right thing to lose.
 */

/* ------------------------------------------------------------------ *
 * Days, in the site's timezone
 * ------------------------------------------------------------------ */

/** One `Intl.DateTimeFormat` per timezone per isolate — constructing one is not free. */
const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dayFormatters.get(timezone)
  if (cached) return cached

  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }
  // A site's timezone is validated on the way in, but a row written before that validation existed,
  // or an IANA name this runtime's ICU does not know, must not take the collector down.
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone })
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
  }

  dayFormatters.set(timezone, formatter)
  return formatter
}

/**
 * `YYYY-MM-DD` for an instant, as the site's own calendar sees it.
 *
 * Every rollup is bucketed this way and every report resolves its range the same way, so the two
 * always agree about where a day ends. Assembled from parts rather than by trusting a locale's
 * pattern, because the format has to be exactly this and a locale is free to change its mind.
 */
export function dayInTimezone(timezone: string, at: Date = new Date()): string {
  const parts = dayFormatter(timezone).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Shifts a `YYYY-MM-DD` by whole days. Pure string arithmetic — no timezone is involved. */
export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

/** Inclusive day count between two `YYYY-MM-DD` values, so `from === to` is 1. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.floor((end - start) / 86_400_000) + 1
}

/** Every day in an inclusive range, in order. The basis for zero-filling a series. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day)
    // A malformed range would otherwise spin; the reporting API caps the span before it gets here.
    if (days.length > 1000) break
  }
  return days
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

const MAX_PATH_LENGTH = 256

/**
 * Reduces whatever the beacon reported to a bare path.
 *
 * Query strings and fragments are dropped rather than stored: they are unbounded cardinality (every
 * campaign parameter would be its own bucket) and they carry whatever a link happened to put in
 * them, which is the sort of thing that turns an aggregate table into a personal-data question.
 */
export function normalisePath(raw: string): string {
  let path = raw.trim()

  // Accept a full URL as readily as a path — `location.href` is what a website has to hand.
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname
    } catch {
      return '/'
    }
  }

  path = path.split('?')[0]!.split('#')[0]!
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/{2,}/g, '/')
  // Trailing slashes are the classic way one page becomes two rows.
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/'

  return path.slice(0, MAX_PATH_LENGTH)
}

/**
 * The bare host a referrer came from, or null when it is this site itself, unparseable, or absent.
 *
 * A *full* referrer URL is never stored: it is both a cardinality bomb and a privacy leak, since the
 * path someone came from can identify them in a way the host cannot. `www.` is folded away so one
 * site is one row.
 */
export function referrerHost(raw: string | undefined, own: (string | null)[]): string | null {
  if (!raw?.trim()) return null

  let host: string
  try {
    host = new URL(raw.trim()).hostname.toLowerCase()
  } catch {
    return null
  }

  host = host.replace(/^www\./, '')
  if (!host) return null

  // An internal navigation is not a referral. Counting it as one would make the biggest "source of
  // traffic" on every site the site itself.
  const mine = own
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase().replace(/^www\./, ''))
  if (mine.includes(host)) return null

  return host.slice(0, 120)
}

/** Share targets are a dimension, so they are folded to a small, predictable alphabet. */
export function normaliseTarget(raw: string | undefined): string {
  const target = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    // Without this, `X (Twitter)` and `X Twitter` become two different targets, one of them
    // trailing a stray hyphen.
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return target || 'unknown'
}

/**
 * Obvious automation, dropped before it is counted.
 *
 * Cheap and imperfect on purpose: a real bot filter is an arms race nobody wins, and this exists so
 * that the first number an operator sees is not mostly crawlers. Anything that wants past it can get
 * past it, which is also true of the endpoint itself.
 */
const BOT_PATTERN =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|discord|preview|monitor|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|node-fetch|go-http-client/i

export function looksLikeBot(userAgent: string | undefined): boolean {
  if (!userAgent) return true
  return BOT_PATTERN.test(userAgent)
}

/**
 * Whether the reader has asked not to be tracked, through either header.
 *
 * Honoured by not writing anything. It is one condition, and it is the difference between a
 * collector an operator can defend and one they cannot.
 */
export function tracksRefused(headers: Headers): boolean {
  return headers.get('dnt') === '1' || headers.get('sec-gpc') === '1'
}

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

interface Bucket {
  metric: AnalyticsMetric
  path: string
  key: string
  entryId: string | null
}

/**
 * Increments one bucket, creating it if this is its first hit of the day.
 *
 * The update comes first and the insert only runs when it matched nothing, so the steady state — a
 * page that has already been viewed today — costs exactly one write. The insert still carries an
 * `ON CONFLICT` because two isolates can reach this line for the same new bucket at once.
 */
async function bump(env: Bindings, siteId: string, date: string, bucket: Bucket): Promise<void> {
  const db = getDb(env)
  const where = and(
    eq(analyticsDaily.siteId, siteId),
    eq(analyticsDaily.date, date),
    eq(analyticsDaily.path, bucket.path),
    eq(analyticsDaily.metric, bucket.metric),
    eq(analyticsDaily.key, bucket.key),
  )

  const updated = await db
    .update(analyticsDaily)
    .set({ count: sql`${analyticsDaily.count} + 1` })
    .where(where)
    .returning({ id: analyticsDaily.id })

  if (updated.length > 0) return

  await db
    .insert(analyticsDaily)
    .values({
      id: newId('anl'),
      siteId,
      date,
      entryId: bucket.entryId,
      path: bucket.path,
      metric: bucket.metric,
      key: bucket.key,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [
        analyticsDaily.siteId,
        analyticsDaily.date,
        analyticsDaily.path,
        analyticsDaily.metric,
        analyticsDaily.key,
      ],
      set: { count: sql`${analyticsDaily.count} + 1` },
    })
}

/**
 * The cap decision itself, given how many distinct values the day already holds.
 *
 * This is the mechanism behind the "bounded by construction" claim: an attacker posting a million
 * distinct paths produces at most `cap + 1` rows for that day, and their traffic is still counted —
 * under `(other)` rather than itemised. Split out from the query so it can be tested as what it is,
 * a rule rather than a round trip.
 */
export function capValue(distinctSoFar: number, cap: number, value: string): string {
  return distinctSoFar < cap ? value : ANALYTICS_OTHER
}

/**
 * Applies a dimension cap to a value that has not been seen today.
 *
 * Only ever reached for a bucket that does not exist yet, so the extra query costs nothing on the
 * hot path.
 */
async function withinCap(
  env: Bindings,
  siteId: string,
  date: string,
  column: typeof analyticsDaily.path | typeof analyticsDaily.key,
  extra: ReturnType<typeof eq> | undefined,
  cap: number,
  value: string,
): Promise<string> {
  const [row] = await getDb(env)
    .select({ distinct: countDistinct(column) })
    .from(analyticsDaily)
    .where(
      and(
        eq(analyticsDaily.siteId, siteId),
        eq(analyticsDaily.date, date),
        ne(column, ''),
        ne(column, ANALYTICS_OTHER),
        extra,
      ),
    )

  return capValue(row?.distinct ?? 0, cap, value)
}

/** Does a bucket for this exact tuple already exist? A known value is never re-capped. */
async function bucketExists(
  env: Bindings,
  siteId: string,
  date: string,
  bucket: Omit<Bucket, 'entryId'>,
): Promise<boolean> {
  const [row] = await getDb(env)
    .select({ id: analyticsDaily.id })
    .from(analyticsDaily)
    .where(
      and(
        eq(analyticsDaily.siteId, siteId),
        eq(analyticsDaily.date, date),
        eq(analyticsDaily.path, bucket.path),
        eq(analyticsDaily.metric, bucket.metric),
        eq(analyticsDaily.key, bucket.key),
      ),
    )
    .limit(1)

  return row !== undefined
}

/**
 * The entry a path belongs to, matched on its slug — the last non-empty segment.
 *
 * Deliberately loose: Hedge is headless and does not know how a website routes, so `/blog/hello` and
 * `/posts/hello/` both find the entry slugged `hello`. A path matching nothing is kept as a path, so
 * listing pages and landing pages are still counted; what it must not do is *invent* an entry, since
 * `entryId` is what the ranked article table joins on.
 */
export async function resolveEntryId(
  env: Bindings,
  siteId: string,
  path: string,
): Promise<string | null> {
  const slug = path.split('/').filter(Boolean).at(-1)
  if (!slug) return null

  const [row] = await getDb(env)
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(collections, eq(collections.id, entries.collectionId))
    .where(and(eq(collections.siteId, siteId), eq(entries.slug, slug)))
    .limit(1)

  return row?.id ?? null
}

/**
 * Records one beacon as counter increments.
 *
 * A view writes two rows' worth of increment: the page itself, and where the reader arrived from.
 * The second is derived here rather than accepted from the client, so nobody can claim inbound
 * traffic from a host without a pageview to go with it.
 */
export async function recordEvent(
  env: Bindings,
  site: SiteRow,
  input: CollectEventInput,
  referrerFrom: string | null,
): Promise<void> {
  const date = dayInTimezone(site.timezone)
  const path = normalisePath(input.path)

  if (input.event === 'share_intent') {
    const target = normaliseTarget(input.target)
    const cappedPath = (await bucketExists(env, site.id, date, {
      metric: 'share_intent',
      path,
      key: target,
    }))
      ? path
      : await withinCap(
          env,
          site.id,
          date,
          analyticsDaily.path,
          undefined,
          ANALYTICS_MAX_PATHS_PER_DAY,
          path,
        )

    const cappedTarget = await withinCap(
      env,
      site.id,
      date,
      analyticsDaily.key,
      eq(analyticsDaily.metric, 'share_intent'),
      ANALYTICS_MAX_SHARE_TARGETS_PER_DAY,
      target,
    )

    await bump(env, site.id, date, {
      metric: 'share_intent',
      path: cappedPath,
      key: cappedTarget,
      entryId: await resolveEntryId(env, site.id, cappedPath),
    })
    return
  }

  const known = await bucketExists(env, site.id, date, { metric: 'view', path, key: '' })
  const cappedPath = known
    ? path
    : await withinCap(
        env,
        site.id,
        date,
        analyticsDaily.path,
        undefined,
        ANALYTICS_MAX_PATHS_PER_DAY,
        path,
      )

  await bump(env, site.id, date, {
    metric: 'view',
    path: cappedPath,
    key: '',
    entryId: known ? null : await resolveEntryId(env, site.id, cappedPath),
  })

  // Referrals are site-wide (`path: ''`): keeping them per page would multiply paths by hosts, which
  // is the one place the caps would still let the table grow faster than anyone expects.
  const host = referrerFrom ?? ANALYTICS_DIRECT
  const cappedHost =
    host === ANALYTICS_DIRECT
      ? host
      : await withinCap(
          env,
          site.id,
          date,
          analyticsDaily.key,
          eq(analyticsDaily.metric, 'referral'),
          ANALYTICS_MAX_REFERRERS_PER_DAY,
          host,
        )

  await bump(env, site.id, date, {
    metric: 'referral',
    path: '',
    key: cappedHost,
    entryId: null,
  })
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * Drops rollups older than the retention window. Run by the daily cron in `index.ts`.
 *
 * Daily rows are small, but "small forever" is still forever, and a deployment nobody is watching is
 * exactly the one that should not accumulate a table. The cutoff is computed in UTC while the rows
 * were bucketed per site timezone, which can spare or drop a day at the boundary — irrelevant at 400
 * days, and the alternative is a query per site to delete rows nobody will look at again.
 */
export async function pruneAnalytics(env: Bindings): Promise<number> {
  const cutoff = addDays(new Date().toISOString().slice(0, 10), -ANALYTICS_RETENTION_DAYS)

  const deleted = await getDb(env)
    .delete(analyticsDaily)
    .where(lt(analyticsDaily.date, cutoff))
    .returning({ id: analyticsDaily.id })

  if (deleted.length > 0) {
    console.log(`[analytics] pruned ${deleted.length} rollup rows older than ${cutoff}`)
  }
  return deleted.length
}
