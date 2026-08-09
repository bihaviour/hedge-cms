import type { AnalyticsEntryStat } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Pencil } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  Caveat,
  CollectorEmptyState,
  RangePicker,
  REFERRER_GROUP_LABEL,
  StatTile,
  Trend,
} from '@/components/analytics-ui'
import { AudienceChart, RankedBars, TrafficChart } from '@/components/charts'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useActiveSite, useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'

/**
 * How many ranked rows are fetched to cut the top ten from. The server ranks by views and the table
 * can be re-sorted by share clicks or by change, so asking for exactly ten would mean "the ten most
 * viewed, re-ordered" — which is not what either of the other two options claims to show. 100 is the
 * endpoint's ceiling.
 */
const ENTRY_RANKING_POOL = 100

/**
 * The questions the dashboard tiles only hint at.
 *
 * Two habits run through the whole page, and both are about not overstating what was measured:
 * every section that reports something the platforms do not actually publish carries its caveat
 * *in the UI*, next to the number, and a range that reaches back before tracking started says so
 * rather than drawing a chart that appears to show traffic collapsing on the day it was switched on.
 */
export function AnalyticsPage() {
  const t = useT()
  const { site } = useActiveSite()
  const siteSlug = useActiveSiteSlug()
  const { formatDate } = useFormatters()
  const [days, setDays] = useState(30)

  const key = [siteSlug, days] as const

  const overview = useQuery({
    queryKey: ['analytics', 'overview', ...key],
    queryFn: () => api.analytics.overview({ days }),
    enabled: Boolean(siteSlug),
  })
  const traffic = useQuery({
    queryKey: ['analytics', 'timeseries', ...key],
    queryFn: () => api.analytics.timeseries({ days, metric: 'view' }),
    enabled: Boolean(siteSlug),
  })
  const entries = useQuery({
    queryKey: ['analytics', 'entries', ...key],
    queryFn: () => api.analytics.entries({ days, limit: ENTRY_RANKING_POOL }),
    enabled: Boolean(siteSlug),
  })
  const referrers = useQuery({
    queryKey: ['analytics', 'referrers', ...key],
    queryFn: () => api.analytics.referrers({ days, limit: 12 }),
    enabled: Boolean(siteSlug),
  })
  const shares = useQuery({
    queryKey: ['analytics', 'shares', ...key],
    queryFn: () => api.analytics.shares({ days, limit: 12 }),
    enabled: Boolean(siteSlug),
  })
  const newsletters = useQuery({
    queryKey: ['analytics', 'newsletters', ...key],
    queryFn: () => api.analytics.newsletters({ days }),
    enabled: Boolean(siteSlug),
  })

  const range = overview.data?.range
  const collecting = overview.data?.collecting ?? true
  // A range that starts before the first recorded day is partial, and the empty left-hand side of
  // the chart is an absence of measurement rather than an absence of readers.
  const partial = Boolean(range?.firstDay && range.firstDay > range.from)

  return (
    <>
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.subtitle', { site: site?.name ?? '' })}
        actions={<RangePicker days={days} onChange={setDays} />}
      />

      <div className="space-y-6 p-8">
        {overview.isLoading && <Skeleton className="h-28" />}

        {overview.data && !collecting && <CollectorEmptyState siteSlug={siteSlug ?? undefined} />}

        {range && (
          <p className="text-muted-foreground text-xs">
            {t('analytics.timezoneNote', { timezone: range.timezone })}
            {partial && range.firstDay
              ? ` ${t('analytics.startsOn', { date: formatDate(range.firstDay) })}`
              : ''}
          </p>
        )}

        {overview.data && collecting && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label={t('analytics.views')} total={overview.data.views} />
            <StatTile label={t('analytics.pages')} total={overview.data.pages} />
            <StatTile label={t('analytics.referrals')} total={overview.data.referrals} />
            <StatTile label={t('analytics.shareIntents')} total={overview.data.shareIntents} />
          </div>
        )}

        {traffic.data && collecting && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('analytics.trafficTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <TrafficChart
                series={traffic.data.series}
                previous={traffic.data.previousSeries}
                label={t('analytics.views')}
                previousLabel={t('analytics.previousPeriod')}
                height={280}
                formatDate={formatDate}
              />
            </CardContent>
          </Card>
        )}

        <EntryTable rows={entries.data ?? []} loading={entries.isLoading} />

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('analytics.referrersTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {referrers.isLoading && <Skeleton className="h-48" />}
              {referrers.data?.length === 0 && (
                <p className="text-muted-foreground text-sm">{t('analytics.referrersEmpty')}</p>
              )}
              {referrers.data && referrers.data.length > 0 && (
                <RankedBars
                  valueLabel={t('analytics.views')}
                  height={Math.max(180, referrers.data.length * 26)}
                  rows={referrers.data.map((row) => ({
                    label: row.host,
                    value: row.count,
                    note: t(REFERRER_GROUP_LABEL[row.group]),
                  }))}
                />
              )}
              <Caveat>{t('analytics.referrersCaveat')}</Caveat>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('analytics.sharesTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {shares.isLoading && <Skeleton className="h-48" />}
              {shares.data?.length === 0 && (
                <p className="text-muted-foreground text-sm">{t('analytics.sharesEmpty')}</p>
              )}
              {shares.data && shares.data.length > 0 && (
                <RankedBars
                  valueLabel={t('analytics.shareIntents')}
                  height={Math.max(180, shares.data.length * 26)}
                  rows={shares.data.map((row) => ({ label: row.target, value: row.count }))}
                />
              )}
              {/* The most important sentence on this page. */}
              <Caveat>{t('analytics.sharesCaveat')}</Caveat>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('analytics.newslettersTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {newsletters.isLoading && <Skeleton className="h-48" />}
            {newsletters.data && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <StatTile
                    label={t('analytics.subscribers')}
                    total={newsletters.data.subscribers}
                  />
                </div>

                <div>
                  <p className="mb-2 font-medium text-sm">{t('analytics.audienceTitle')}</p>
                  <AudienceChart points={newsletters.data.audience} t={t} formatDate={formatDate} />
                </div>

                {newsletters.data.campaigns.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('analytics.newslettersEmpty')}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('analytics.colCampaign')}</TableHead>
                        <TableHead>{t('analytics.colSent')}</TableHead>
                        <TableHead className="text-right">{t('analytics.colAccepted')}</TableHead>
                        <TableHead className="text-right">{t('analytics.colFailed')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {newsletters.data.campaigns.map((campaign) => (
                        <TableRow key={campaign.newsletterId}>
                          <TableCell className="font-medium">{campaign.subject}</TableCell>
                          <TableCell>{formatDate(campaign.sentAt)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {campaign.accepted.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {campaign.failed.toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                <Caveat>
                  {t('analytics.acceptedNote')} {t('analytics.noOpensNote')}
                </Caveat>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}

type SortKey = 'views' | 'trend' | 'shares'

/** How many articles the leaderboard shows. */
const TOP_ARTICLES = 10

/**
 * The leaderboard: the ten articles the chosen measure puts first, so a climbing piece is
 * distinguishable from an old spike.
 *
 * It is a *top ten* and not the whole catalogue on purpose. Every article now carries its own
 * views, trend and share clicks in its collection's entries table, which is where somebody looking
 * for one particular piece goes — a second, longer copy of that list here answered a question this
 * page is not for, and buried the ten rows that are the point of it.
 *
 * The ranking is still cut from a wider set than it shows (`ENTRY_RANKING_POOL`), because sorting
 * ten rows by share clicks would only re-order the ten most *viewed* and call the result "most
 * shared".
 */
function EntryTable({ rows, loading }: { rows: AnalyticsEntryStat[]; loading: boolean }) {
  const t = useT()
  const [sort, setSort] = useState<SortKey>('views')

  const sorted = [...rows]
    .sort((a, b) => {
      if (sort === 'shares') return b.shareIntents - a.shareIntents
      if (sort === 'trend') return b.views - b.previousViews - (a.views - a.previousViews)
      return b.views - a.views
    })
    .slice(0, TOP_ARTICLES)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">{t('analytics.entriesTitle')}</CardTitle>
        <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="views">{t('analytics.sortViews')}</SelectItem>
            <SelectItem value="trend">{t('analytics.sortTrend')}</SelectItem>
            <SelectItem value="shares">{t('analytics.sortShares')}</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {loading && <Skeleton className="h-48" />}
        {!loading && sorted.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('analytics.entriesEmpty')}</p>
        )}
        {sorted.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('analytics.colArticle')}</TableHead>
                <TableHead className="text-right">{t('analytics.colViews')}</TableHead>
                <TableHead className="text-right">{t('analytics.colTrend')}</TableHead>
                <TableHead className="text-right">{t('analytics.colShares')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={row.path}>
                  <TableCell>
                    {row.entryId ? (
                      <Link
                        className="font-medium hover:underline"
                        to={`/analytics/${row.entryId}`}
                      >
                        {row.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{row.title}</span>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {row.path}
                      {/* A path with no entry is still traffic — a listing page, a landing page —
                          and saying so beats leaving somebody to wonder why it has no link. */}
                      {!row.entryId && ` · ${t('analytics.noEntryMatch')}`}
                    </p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.views.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Trend current={row.views} previous={row.previousViews} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.shareIntents.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

/** One article's traffic — reachable from the ranked table and from the entry editor. */
export function EntryAnalyticsPage() {
  const t = useT()
  const { entryId = '' } = useParams()
  const siteSlug = useActiveSiteSlug()
  const { formatDate } = useFormatters()
  const [days, setDays] = useState(30)

  const entry = useQuery({
    queryKey: ['analytics', 'entry', siteSlug, entryId, days],
    queryFn: () => api.analytics.entry(entryId, { days }),
    enabled: Boolean(siteSlug && entryId),
  })

  // Arriving here from the leaderboard, the article itself is one click away and the editor is
  // nowhere — an entry id is not a route into it. The response carries the entry's address for
  // exactly this, and it is absent only for traffic that outlived the entry that earned it.
  const article = entry.data
  const editHref =
    article?.collectionSlug && article.slug
      ? `/collections/${article.collectionSlug}/entries/${article.slug}?locale=${article.locale ?? ''}`
      : null

  return (
    <>
      <PageHeader
        title={t('analytics.entryTitle', { title: entry.data?.title ?? '…' })}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link to="/analytics">
                <ArrowLeft className="size-4" />
                {t('analytics.backToAll')}
              </Link>
            </Button>
            {editHref && (
              <Button asChild variant="outline">
                <Link to={editHref}>
                  <Pencil className="size-4" />
                  {t('analytics.backToEdit')}
                </Link>
              </Button>
            )}
            <RangePicker days={days} onChange={setDays} />
          </div>
        }
      />

      <div className="space-y-6 p-8">
        {entry.isLoading && <Skeleton className="h-64" />}
        {entry.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatTile
                label={t('analytics.entryViews')}
                total={{ value: entry.data.views, previous: entry.data.previousViews }}
              />
              <StatTile
                label={t('analytics.entryShares')}
                total={{ value: entry.data.shareIntents, previous: 0 }}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('analytics.trafficTitle')}</CardTitle>
              </CardHeader>
              <CardContent>
                <TrafficChart
                  series={entry.data.series}
                  previous={entry.data.previousSeries}
                  label={t('analytics.views')}
                  previousLabel={t('analytics.previousPeriod')}
                  height={280}
                  formatDate={formatDate}
                />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  )
}
