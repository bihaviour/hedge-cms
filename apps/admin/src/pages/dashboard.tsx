import type { Entry } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import { CollectorEmptyState, StatTile, Trend } from '@/components/analytics-ui'
import { TrafficChart } from '@/components/charts'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useActiveSite, useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'

/**
 * The front door.
 *
 * `/` used to redirect to `/collections`, which meant a signed-in operator landed in a file listing
 * and the question "how is the website doing" had nowhere to go. It lands here now — a change every
 * existing user notices on their next sign-in, and a deliberate one: a CMS whose front door is a
 * folder listing is a weaker product than one that opens on what the writing achieved.
 *
 * Everything on this page is either an analytics rollup or a row the CMS already had. Nothing here
 * is a delivery API request count: the Worker sits behind an edge cache the reader's browser never
 * touches, so those counts are not pageviews and the factor between them is unknowable.
 */
export function DashboardPage() {
  const t = useT()
  const { site } = useActiveSite()
  const siteSlug = useActiveSiteSlug()
  const { formatDate } = useFormatters()

  // Fixed at 30 days here — the dashboard answers "how are things", and the range picker that
  // answers "how were things in March" lives on `/analytics`.
  const days = 30

  const overview = useQuery({
    queryKey: ['analytics', 'overview', siteSlug, days],
    queryFn: () => api.analytics.overview({ days }),
    enabled: Boolean(siteSlug),
  })

  const topArticles = useQuery({
    queryKey: ['analytics', 'entries', siteSlug, days, 5],
    queryFn: () => api.analytics.entries({ days, limit: 5 }),
    enabled: Boolean(siteSlug),
  })

  const collecting = overview.data?.collecting ?? true

  return (
    <>
      <PageHeader
        title={t('dash.title')}
        description={t('dash.subtitle', { site: site?.name ?? '' })}
        actions={
          <Button asChild variant="outline">
            <Link to="/analytics">
              {t('dash.viewAnalytics')}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        }
      />

      <div className="space-y-6 p-8">
        {overview.isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-28" />
            ))}
          </div>
        )}

        {/* An empty chart reads as a website nobody visited. Say which of the two it is. */}
        {overview.data && !collecting && <CollectorEmptyState siteSlug={siteSlug ?? undefined} />}

        {overview.data && collecting && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                label={t('analytics.views')}
                total={overview.data.views}
                chart={
                  <TrafficChart
                    series={overview.data.series}
                    label={t('analytics.views')}
                    height={56}
                    compact
                    formatDate={formatDate}
                  />
                }
              />
              <StatTile label={t('analytics.pages')} total={overview.data.pages} />
              <StatTile label={t('analytics.referrals')} total={overview.data.referrals} />
              <StatTile label={t('analytics.shareIntents')} total={overview.data.shareIntents} />
            </div>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">{t('analytics.trafficTitle')}</CardTitle>
                <span className="text-muted-foreground text-xs">
                  {t('analytics.timezoneNote', { timezone: overview.data.range.timezone })}
                </span>
              </CardHeader>
              <CardContent>
                <TrafficChart
                  series={overview.data.series}
                  label={t('analytics.views')}
                  height={220}
                  formatDate={formatDate}
                />
              </CardContent>
            </Card>
          </>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <TopArticles rows={topArticles.data ?? []} loading={topArticles.isLoading} />
          <div className="space-y-4">
            <RecentlyUpdated />
            <LastNewsletter />
          </div>
        </div>
      </div>
    </>
  )
}

/** The ranked table, truncated. Each row links straight into the editor for that entry. */
function TopArticles({
  rows,
  loading,
}: {
  rows: Awaited<ReturnType<typeof api.analytics.entries>>
  loading: boolean
}) {
  const t = useT()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('dash.topArticles')}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <Skeleton className="h-32" />}
        {!loading && rows.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('dash.topArticlesEmpty')}</p>
        )}
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.path} className="flex items-center justify-between gap-4 py-2 text-sm">
              <div className="min-w-0">
                {row.collectionSlug && row.slug ? (
                  <Link
                    className="truncate font-medium hover:underline"
                    to={`/collections/${row.collectionSlug}/entries/${row.slug}?locale=${row.locale ?? 'en'}`}
                  >
                    {row.title}
                  </Link>
                ) : (
                  <span className="truncate font-medium">{row.title}</span>
                )}
                <p className="truncate text-muted-foreground text-xs">{row.path}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums">{row.views.toLocaleString()}</span>
                <Trend current={row.views} previous={row.previousViews} />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/**
 * What has been edited lately, across every collection on the site.
 *
 * Merged in the client rather than behind a new endpoint: entries are listed per collection, and a
 * site has a handful of collections, so this is a few small indexed queries rather than a reason to
 * grow the API.
 */
function RecentlyUpdated() {
  const t = useT()
  const siteSlug = useActiveSiteSlug()
  const { formatDate } = useFormatters()

  const recent = useQuery({
    queryKey: ['dashboard', 'recent-entries', siteSlug],
    enabled: Boolean(siteSlug),
    queryFn: async () => {
      const collections = await api.collections.list()
      const pages = await Promise.all(
        collections.slice(0, 6).map(async (collection) => {
          const page = await api.entries.list(collection.slug, {
            sort: 'updatedAt',
            order: 'desc',
            limit: 5,
          })
          return page.data.map((entry) => ({ entry, collectionSlug: collection.slug }))
        }),
      )
      return pages
        .flat()
        .sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))
        .slice(0, 5)
    },
  })

  const title = (entry: Entry) =>
    typeof entry.data.title === 'string' && entry.data.title ? entry.data.title : entry.slug

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('dash.recentlyUpdated')}</CardTitle>
      </CardHeader>
      <CardContent>
        {recent.isLoading && <Skeleton className="h-24" />}
        {recent.data?.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('dash.recentlyUpdatedEmpty')}</p>
        )}
        <ul className="divide-y">
          {recent.data?.map(({ entry, collectionSlug }) => (
            <li
              key={`${collectionSlug}/${entry.slug}/${entry.locale}`}
              className="flex items-center justify-between gap-4 py-2 text-sm"
            >
              <Link
                className="truncate font-medium hover:underline"
                to={`/collections/${collectionSlug}/entries/${entry.slug}?locale=${entry.locale}`}
              >
                {title(entry)}
              </Link>
              <span className="shrink-0 text-muted-foreground text-xs">
                {formatDate(entry.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** The last campaign and how it went, from rows the send path already writes. */
function LastNewsletter() {
  const t = useT()
  const siteSlug = useActiveSiteSlug()
  const { formatDate } = useFormatters()

  const last = useQuery({
    queryKey: ['dashboard', 'last-newsletter', siteSlug],
    enabled: Boolean(siteSlug),
    queryFn: async () => {
      const page = await api.newsletters.list()
      const sent = page.data.find((newsletter) => newsletter.status === 'sent')
      if (!sent) return null
      return { newsletter: sent, delivery: await api.analytics.newsletter(sent.id) }
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('dash.lastNewsletter')}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {last.isLoading && <Skeleton className="h-16" />}
        {last.data === null && (
          <p className="text-muted-foreground">{t('dash.lastNewsletterEmpty')}</p>
        )}
        {last.data && (
          <div className="space-y-1">
            <Link to="/newsletters" className="font-medium hover:underline">
              {last.data.newsletter.subject}
            </Link>
            <p className="text-muted-foreground text-xs">
              {t('dash.newsletterSent', {
                date: formatDate(last.data.newsletter.sentAt),
                count: last.data.newsletter.recipientCount ?? 0,
              })}
            </p>
            <p className="text-muted-foreground text-xs tabular-nums">
              {t('analytics.colAccepted')}: {last.data.delivery.accepted.toLocaleString()} ·{' '}
              {t('analytics.colFailed')}: {last.data.delivery.failed.toLocaleString()}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
