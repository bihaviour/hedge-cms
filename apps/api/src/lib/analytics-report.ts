import {
  ANALYTICS_DEFAULT_RANGE_DAYS,
  ANALYTICS_DIRECT,
  ANALYTICS_MAX_RANGE_DAYS,
  type AnalyticsEntryStat,
  type AnalyticsMetric,
  type AnalyticsOverview,
  type AnalyticsPoint,
  type AnalyticsRange,
  type AnalyticsRangeQuery,
  type AnalyticsReferrerStat,
  type AnalyticsShareStat,
  type AnalyticsTimeseries,
  type ReferrerGroup,
} from '@hedge/core'
import { and, asc, countDistinct, desc, eq, gte, inArray, lte, min, ne, sum } from 'drizzle-orm'
import { getDb } from '../db/client'
import { analyticsDaily, collections, entries, type SiteRow } from '../db/schema'
import type { Bindings } from '../env'
import { addDays, dayInTimezone, daysBetween, eachDay } from './analytics'
import { ApiError } from './errors'

/**
 * The read side of website analytics: everything the dashboard and `/analytics` render.
 *
 * Two properties every query here holds to, because the alternatives produce charts that lie:
 *
 * - **Days are cut in the site's timezone**, the same way the rollups were written. The admin never
 *   re-derives a day boundary of its own; two different answers to "what is today" is the classic
 *   way these pages start disagreeing with themselves.
 * - **A series is complete.** A day with no traffic has no row, and a chart that simply omits it
 *   draws a line straight across the gap and implies traffic that was never measured.
 */

/** `sum()` comes back as a string on SQLite, and as null for an empty group. */
const toNumber = (value: string | number | null): number => Number(value ?? 0) || 0

/* ------------------------------------------------------------------ *
 * Ranges
 * ------------------------------------------------------------------ */

/**
 * Resolves `?from`/`?to` into a concrete window, the equal-length window before it, and the first
 * day this site has any data for.
 *
 * The comparison window is resolved here rather than left to the client for the same reason the
 * totals are: every number on the overview is worth roughly nothing without the previous period
 * beside it, and making the admin issue a second request and do the arithmetic is how the two
 * eventually disagree.
 */
export async function resolveRange(
  env: Bindings,
  site: SiteRow,
  query: AnalyticsRangeQuery,
): Promise<AnalyticsRange> {
  const today = dayInTimezone(site.timezone)
  const to = query.to ?? today
  // `days` is the picker's "last N days", cut here because only the server knows where the site's
  // day ends. An explicit `from` still wins.
  const requested = query.days ?? ANALYTICS_DEFAULT_RANGE_DAYS
  const from = query.from ?? addDays(to, -(requested - 1))

  if (from > to) throw ApiError.badRequest('"from" must not be after "to"')

  const span = daysBetween(from, to)
  if (span > ANALYTICS_MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`A range may cover at most ${ANALYTICS_MAX_RANGE_DAYS} days`)
  }

  const previousTo = addDays(from, -1)

  const [row] = await getDb(env)
    .select({ first: min(analyticsDaily.date) })
    .from(analyticsDaily)
    .where(eq(analyticsDaily.siteId, site.id))

  return {
    from,
    to,
    timezone: site.timezone,
    previous: { from: addDays(previousTo, -(span - 1)), to: previousTo },
    firstDay: row?.first ?? null,
  }
}

/** Every query in this file is scoped to one site and one window. Nothing else may be. */
const inWindow = (siteId: string, from: string, to: string) =>
  and(
    eq(analyticsDaily.siteId, siteId),
    gte(analyticsDaily.date, from),
    lte(analyticsDaily.date, to),
  )

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

interface WindowTotals {
  views: number
  shareIntents: number
  referrals: number
  pages: number
}

async function windowTotals(
  env: Bindings,
  siteId: string,
  from: string,
  to: string,
): Promise<WindowTotals> {
  const db = getDb(env)

  const byMetric = await db
    .select({ metric: analyticsDaily.metric, total: sum(analyticsDaily.count) })
    .from(analyticsDaily)
    .where(inWindow(siteId, from, to))
    .groupBy(analyticsDaily.metric)

  // Referrals count *external* arrivals only. Every view also writes a referral row, so including
  // `(direct)` would make this tile a second, slightly wrong copy of the views tile.
  const [external] = await db
    .select({ total: sum(analyticsDaily.count) })
    .from(analyticsDaily)
    .where(
      and(
        inWindow(siteId, from, to),
        eq(analyticsDaily.metric, 'referral'),
        ne(analyticsDaily.key, ANALYTICS_DIRECT),
      ),
    )

  const [pages] = await db
    .select({ distinct: countDistinct(analyticsDaily.path) })
    .from(analyticsDaily)
    .where(and(inWindow(siteId, from, to), eq(analyticsDaily.metric, 'view')))

  const total = (metric: AnalyticsMetric) =>
    toNumber(byMetric.find((row) => row.metric === metric)?.total ?? 0)

  return {
    views: total('view'),
    shareIntents: total('share_intent'),
    referrals: toNumber(external?.total ?? 0),
    pages: pages?.distinct ?? 0,
  }
}

/** Daily totals for one metric, zero-filled across the whole window. */
async function series(
  env: Bindings,
  siteId: string,
  from: string,
  to: string,
  metric: AnalyticsMetric,
  entryId?: string,
): Promise<AnalyticsPoint[]> {
  const rows = await getDb(env)
    .select({ date: analyticsDaily.date, total: sum(analyticsDaily.count) })
    .from(analyticsDaily)
    .where(
      and(
        inWindow(siteId, from, to),
        eq(analyticsDaily.metric, metric),
        entryId ? eq(analyticsDaily.entryId, entryId) : undefined,
      ),
    )
    .groupBy(analyticsDaily.date)
    .orderBy(asc(analyticsDaily.date))

  const counts = new Map(rows.map((row) => [row.date, toNumber(row.total)]))
  return eachDay(from, to).map((date) => ({ date, count: counts.get(date) ?? 0 }))
}

export async function overview(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
): Promise<AnalyticsOverview> {
  const [now, before, points] = await Promise.all([
    windowTotals(env, site.id, range.from, range.to),
    windowTotals(env, site.id, range.previous.from, range.previous.to),
    series(env, site.id, range.from, range.to, 'view'),
  ])

  return {
    range,
    views: { value: now.views, previous: before.views },
    shareIntents: { value: now.shareIntents, previous: before.shareIntents },
    referrals: { value: now.referrals, previous: before.referrals },
    pages: { value: now.pages, previous: before.pages },
    series: points,
  }
}

export async function timeseries(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
  metric: AnalyticsMetric,
  entryId?: string,
): Promise<AnalyticsTimeseries> {
  const [current, previous] = await Promise.all([
    series(env, site.id, range.from, range.to, metric, entryId),
    series(env, site.id, range.previous.from, range.previous.to, metric, entryId),
  ])

  return { range, metric, series: current, previousSeries: previous }
}

/* ------------------------------------------------------------------ *
 * The ranked article table
 * ------------------------------------------------------------------ */

/**
 * Views per path, with share intents and the previous window's views beside them.
 *
 * Ranked and truncated rather than paginated: the path dimension is already capped per day
 * (`ANALYTICS_MAX_PATHS_PER_DAY`), so this list is naturally bounded, and nobody reads page four of
 * a traffic table. Titles are resolved in one indexed join at the end — a lookup per row would be a
 * query per article on every dashboard render.
 */
export async function entryStats(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
  limit: number,
): Promise<AnalyticsEntryStat[]> {
  const db = getDb(env)

  const [views, shares, before] = await Promise.all([
    db
      .select({
        path: analyticsDaily.path,
        entryId: analyticsDaily.entryId,
        total: sum(analyticsDaily.count),
      })
      .from(analyticsDaily)
      .where(and(inWindow(site.id, range.from, range.to), eq(analyticsDaily.metric, 'view')))
      .groupBy(analyticsDaily.path, analyticsDaily.entryId)
      .orderBy(desc(sum(analyticsDaily.count)))
      .limit(limit),
    db
      .select({ path: analyticsDaily.path, total: sum(analyticsDaily.count) })
      .from(analyticsDaily)
      .where(
        and(inWindow(site.id, range.from, range.to), eq(analyticsDaily.metric, 'share_intent')),
      )
      .groupBy(analyticsDaily.path),
    db
      .select({ path: analyticsDaily.path, total: sum(analyticsDaily.count) })
      .from(analyticsDaily)
      .where(
        and(
          inWindow(site.id, range.previous.from, range.previous.to),
          eq(analyticsDaily.metric, 'view'),
        ),
      )
      .groupBy(analyticsDaily.path),
  ])

  const shareByPath = new Map(shares.map((row) => [row.path, toNumber(row.total)]))
  const beforeByPath = new Map(before.map((row) => [row.path, toNumber(row.total)]))

  const ids = [
    ...new Set(views.map((row) => row.entryId).filter((id): id is string => Boolean(id))),
  ]
  const titles = await entryTitles(env, site.id, ids)

  return views.map((row) => {
    const entry = row.entryId ? titles.get(row.entryId) : undefined
    return {
      entryId: row.entryId,
      path: row.path,
      title: entry?.title ?? row.path,
      collectionSlug: entry?.collectionSlug ?? null,
      slug: entry?.slug ?? null,
      locale: entry?.locale ?? null,
      views: toNumber(row.total),
      previousViews: beforeByPath.get(row.path) ?? 0,
      shareIntents: shareByPath.get(row.path) ?? 0,
    }
  })
}

interface EntryLabel {
  title: string
  slug: string
  locale: string
  collectionSlug: string
}

/** Titles live inside `entries.data`, so they are read out of the JSON rather than joined to. */
export async function entryTitles(
  env: Bindings,
  siteId: string,
  ids: string[],
): Promise<Map<string, EntryLabel>> {
  const labels = new Map<string, EntryLabel>()
  if (ids.length === 0) return labels

  const rows = await getDb(env)
    .select({
      id: entries.id,
      slug: entries.slug,
      locale: entries.locale,
      data: entries.data,
      collectionSlug: collections.slug,
    })
    .from(entries)
    .innerJoin(collections, eq(collections.id, entries.collectionId))
    // The tenant filter is not redundant: `entryId` came off a row, and a row is only ever this
    // site's to describe.
    .where(and(eq(collections.siteId, siteId), inArray(entries.id, ids)))

  for (const row of rows) {
    const title = typeof row.data?.title === 'string' ? row.data.title : row.slug
    labels.set(row.id, {
      title,
      slug: row.slug,
      locale: row.locale,
      collectionSlug: row.collectionSlug,
    })
  }

  return labels
}

/* ------------------------------------------------------------------ *
 * Referrers and shares
 * ------------------------------------------------------------------ */

const SEARCH_HOSTS = /^(www\.)?(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|brave|startpage)\./
const SOCIAL_HOSTS =
  /^(www\.)?(x\.com|twitter|t\.co|facebook|fb\.|instagram|linkedin|lnkd\.in|reddit|news\.ycombinator|pinterest|mastodon|bsky|threads|tiktok|youtube|youtu\.be|whatsapp|telegram|t\.me|medium|substack)/

/**
 * The coarse bucket a host is shown under. Grouping matters: thirty domains in a list is not an
 * answer to "where do readers come from", and three categories is.
 */
export function referrerGroup(host: string): ReferrerGroup {
  if (host === ANALYTICS_DIRECT) return 'direct'
  if (SEARCH_HOSTS.test(host)) return 'search'
  if (SOCIAL_HOSTS.test(host)) return 'social'
  return 'other'
}

export async function referrerStats(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
  limit: number,
): Promise<AnalyticsReferrerStat[]> {
  return (await dimensionStats(env, site, range, 'referral', limit)).map(
    ({ key, count, previousCount }) => ({
      host: key,
      group: referrerGroup(key),
      count,
      previousCount,
    }),
  )
}

export async function shareStats(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
  limit: number,
): Promise<AnalyticsShareStat[]> {
  return (await dimensionStats(env, site, range, 'share_intent', limit)).map(
    ({ key, count, previousCount }) => ({ target: key, count, previousCount }),
  )
}

/** Top values of one metric's `key` dimension, with the previous window's counts alongside. */
async function dimensionStats(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
  metric: AnalyticsMetric,
  limit: number,
): Promise<{ key: string; count: number; previousCount: number }[]> {
  const db = getDb(env)

  const select = (from: string, to: string, take?: number) => {
    const query = db
      .select({ key: analyticsDaily.key, total: sum(analyticsDaily.count) })
      .from(analyticsDaily)
      .where(and(inWindow(site.id, from, to), eq(analyticsDaily.metric, metric)))
      .groupBy(analyticsDaily.key)
      .orderBy(desc(sum(analyticsDaily.count)))
    return take ? query.limit(take) : query
  }

  const [current, previous] = await Promise.all([
    select(range.from, range.to, limit),
    select(range.previous.from, range.previous.to),
  ])

  const beforeByKey = new Map(previous.map((row) => [row.key, toNumber(row.total)]))

  return current.map((row) => ({
    key: row.key,
    count: toNumber(row.total),
    previousCount: beforeByKey.get(row.key) ?? 0,
  }))
}

/** One entry's totals over a window — the numbers beside its per-entry chart. */
export async function entryTotals(
  env: Bindings,
  site: SiteRow,
  range: AnalyticsRange,
  entryId: string,
): Promise<{ views: number; previousViews: number; shareIntents: number }> {
  const db = getDb(env)

  const total = async (from: string, to: string, metric: AnalyticsMetric) => {
    const [row] = await db
      .select({ total: sum(analyticsDaily.count) })
      .from(analyticsDaily)
      .where(
        and(
          inWindow(site.id, from, to),
          eq(analyticsDaily.metric, metric),
          eq(analyticsDaily.entryId, entryId),
        ),
      )
    return toNumber(row?.total ?? 0)
  }

  const [views, previousViews, shareIntents] = await Promise.all([
    total(range.from, range.to, 'view'),
    total(range.previous.from, range.previous.to, 'view'),
    total(range.from, range.to, 'share_intent'),
  ])

  return { views, previousViews, shareIntents }
}

/** Whether this site has ever recorded anything. Drives the "embed the script" empty state. */
export async function hasAnyData(env: Bindings, siteId: string): Promise<boolean> {
  const [row] = await getDb(env)
    .select({ id: analyticsDaily.id })
    .from(analyticsDaily)
    .where(eq(analyticsDaily.siteId, siteId))
    .limit(1)
  return row !== undefined
}
