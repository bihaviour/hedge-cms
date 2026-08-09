import { ANALYTICS_METRICS, analyticsRangeSchema } from '@hedge/core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import {
  collectionEntryTotals,
  entryStats,
  entryTitles,
  entryTotals,
  hasAnyData,
  overview,
  referrerStats,
  resolveRange,
  shareStats,
  timeseries,
} from '../lib/analytics-report'
import { requireSiteRole } from '../lib/auth'
import { findCollection } from '../lib/collections'
import { newsletterAnalytics, newsletterDelivery } from '../lib/newsletter-stats'
import { requireSite } from '../lib/site'
import { validateQuery } from '../lib/validate'

/**
 * Reading website analytics. Mounted at `/api/v1/analytics`, which is in `ADMIN_PREFIXES` — session
 * only, because analytics is not an authoring surface a machine needs.
 *
 * `viewer` throughout: anyone who can already see a site's content can see how it performed. The
 * numbers describe the site, not the people running it.
 *
 * Nothing here is edge-cacheable. These responses are per-session, per-site management data, so they
 * carry `private, no-store` and no `s-maxage` at all — the opposite of the delivery API, whose long
 * `s-maxage` is the very reason the Worker cannot see website traffic in the first place.
 */
const app = new Hono<AppEnv>()

app.use('*', requireSiteRole('viewer'))

app.use('*', async (c, next) => {
  await next()
  c.header('cache-control', 'private, no-store')
})

const rangeWithLimit = analyticsRangeSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

/** Which collection's entries to report on. Required: there is no useful whole-site answer here. */
const entryTotalsQuery = analyticsRangeSchema.extend({
  collection: z.string().min(1).max(64),
})

/** Headline totals, each against the previous period, plus the sparkline. */
app.get('/overview', async (c) => {
  const site = requireSite(c)
  const range = await resolveRange(c.env, site, validateQuery(c, analyticsRangeSchema))

  return c.json({
    data: {
      ...(await overview(c.env, site, range)),
      // Distinguishes "no traffic in this range" from "the script was never embedded". They look
      // identical on a chart and mean completely different things to whoever is reading it.
      collecting: await hasAnyData(c.env, site.id),
    },
  })
})

const timeseriesQuery = analyticsRangeSchema.extend({
  metric: z.enum(ANALYTICS_METRICS).default('view'),
  entryId: z.string().max(64).optional(),
})

/** Daily counts for one metric, with the previous window alongside for comparison. */
app.get('/timeseries', async (c) => {
  const site = requireSite(c)
  const query = validateQuery(c, timeseriesQuery)
  const range = await resolveRange(c.env, site, query)

  return c.json({ data: await timeseries(c.env, site, range, query.metric, query.entryId) })
})

/** The ranked article table. */
app.get('/entries', async (c) => {
  const site = requireSite(c)
  const query = validateQuery(c, rangeWithLimit)
  const range = await resolveRange(c.env, site, query)

  return c.json({ data: await entryStats(c.env, site, range, query.limit) })
})

/**
 * Per-entry totals for one collection — what the entries table puts beside each row.
 *
 * Registered before `/entries/:entryId` so the static segment wins, which it also would by id shape
 * (`ent_…`); the ordering is for the reader rather than the router.
 */
app.get('/entries/totals', async (c) => {
  const site = requireSite(c)
  const query = validateQuery(c, entryTotalsQuery)
  const collection = await findCollection(c.env, site.id, query.collection)
  const range = await resolveRange(c.env, site, query)

  return c.json({ data: await collectionEntryTotals(c.env, site, range, collection.id) })
})

/**
 * One article's traffic — the view an author actually wants.
 *
 * The entry's address travels with it (`collectionSlug`, `slug`, `locale`) because this page is
 * reached from the ranked table as often as from the editor, and somebody who arrives from the
 * ranking has no way back to the article otherwise — an entry id is not a route into the editor.
 * They are null for an entry that has since been deleted, whose traffic outlives it.
 */
app.get('/entries/:entryId', async (c) => {
  const site = requireSite(c)
  const entryId = c.req.param('entryId')
  const range = await resolveRange(c.env, site, validateQuery(c, analyticsRangeSchema))

  const [totals, series, labels] = await Promise.all([
    entryTotals(c.env, site, range, entryId),
    timeseries(c.env, site, range, 'view', entryId),
    entryTitles(c.env, site.id, [entryId]),
  ])

  const label = labels.get(entryId)

  return c.json({
    data: {
      entryId,
      title: label?.title ?? null,
      collectionSlug: label?.collectionSlug ?? null,
      slug: label?.slug ?? null,
      locale: label?.locale ?? null,
      range,
      ...totals,
      series: series.series,
      previousSeries: series.previousSeries,
    },
  })
})

/** Where readers arrive from, as hosts with a coarse group each. */
app.get('/referrers', async (c) => {
  const site = requireSite(c)
  const query = validateQuery(c, rangeWithLimit)
  const range = await resolveRange(c.env, site, query)

  return c.json({ data: await referrerStats(c.env, site, range, query.limit) })
})

/**
 * Share intents by target.
 *
 * These are clicks on the *website's own* share controls, not counts reported by any platform — X
 * removed its count endpoint, Facebook's needs an app token, LinkedIn withdrew theirs. The admin
 * carries that caveat in the UI, where it is read, not only here.
 */
app.get('/shares', async (c) => {
  const site = requireSite(c)
  const query = validateQuery(c, rangeWithLimit)
  const range = await resolveRange(c.env, site, query)

  return c.json({ data: await shareStats(c.env, site, range, query.limit) })
})

/** Newsletter performance — no collector involved, only rows the send path already writes. */
app.get('/newsletters', async (c) => {
  const site = requireSite(c)
  const range = await resolveRange(c.env, site, validateQuery(c, analyticsRangeSchema))

  return c.json({ data: await newsletterAnalytics(c.env, site, range) })
})

/** Delivery for one campaign, for the newsletter's own page. */
app.get('/newsletters/:id', async (c) => {
  const site = requireSite(c)
  return c.json({ data: await newsletterDelivery(c.env, site.id, c.req.param('id')) })
})

export default app
