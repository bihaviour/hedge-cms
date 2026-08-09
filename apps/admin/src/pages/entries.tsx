import {
  ANALYTICS_ENTRY_COLUMN_DAYS,
  type AnalyticsEntryTotals,
  type Entry,
  type EntryStatus,
  localeLabel,
} from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { Lock, Plus, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Trend } from '@/components/analytics-ui'
import { EntryRowActions } from '@/components/entry-row-actions'
import { EmptyState, PageHeader } from '@/components/page-header'
import { TablePagination } from '@/components/table-pagination'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { useKeysetPage } from '@/hooks/use-paged-query'
import { useActiveSite, useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n/catalog'

const STATUS_VARIANT: Record<EntryStatus, 'default' | 'secondary' | 'outline'> = {
  published: 'default',
  draft: 'secondary',
  archived: 'outline',
}

const STATUS_LABEL: Record<EntryStatus, MessageKey> = {
  draft: 'entries.statusDraft',
  published: 'entries.statusPublished',
  archived: 'entries.statusArchived',
}

/**
 * One post's languages: which exist, what state each is in, and the ones still to write.
 *
 * A missing language is rendered as an outlined chip rather than left out, because "not translated
 * yet" is the thing an editor of a multilingual site is actually scanning for — and it links
 * straight into the editor at that language, where the empty form is the one for writing it.
 *
 * Each chip carries the *sibling's own* slug. Translations may have URLs in their own language now,
 * so the row's slug is only its own, and linking every chip to it would open the wrong entry.
 */
function LocaleChips({
  collection,
  locales,
  entry,
  missingLabel,
}: {
  collection: string
  locales: string[]
  entry: Entry
  missingLabel: string
}) {
  const written = new Map((entry.translations ?? []).map((one) => [one.locale, one]))

  return (
    <div className="flex flex-wrap gap-1">
      {locales.map((code) => {
        const variant = written.get(code)
        if (!variant) {
          return (
            <Link
              key={code}
              to={`/collections/${collection}/entries/${entry.slug}?locale=${code}`}
              title={`${missingLabel} · ${localeLabel(code)}`}
              className="rounded border border-dashed px-1.5 py-0.5 text-muted-foreground text-xs hover:border-solid hover:text-foreground"
            >
              + {code}
            </Link>
          )
        }
        return (
          <Link
            key={code}
            to={`/collections/${collection}/entries/${variant.slug}?locale=${code}`}
            title={`${variant.slug} · ${localeLabel(code)}`}
            className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent"
          >
            {code}
            {/* Published is the unmarked case: a dot next to the two that are not saves reading a
                status word per language on every row. */}
            {variant.status !== 'published' && (
              <span className="ml-1 text-muted-foreground">
                {variant.status === 'draft' ? '·' : '×'}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}

/**
 * One post's traffic, summed across the languages it is written in.
 *
 * On a multilingual site this table lists *posts*, one line each, so the number beside a line has
 * to be the piece's — a rollup is keyed by the entry row a path resolved to, which is one language.
 * Reporting only the row's own id would say an article was read a third as often as it was on a
 * site whose readers are split across three languages.
 *
 * Nothing recorded is `undefined` rather than `0`: the columns are hidden entirely on a collection
 * with no traffic, so a zero inside them means "read by nobody", which is a different statement.
 */
function postTraffic(
  entry: Entry,
  totals: Map<string, AnalyticsEntryTotals>,
): AnalyticsEntryTotals | undefined {
  const ids = entry.translations?.length ? entry.translations.map((one) => one.id) : [entry.id]
  const rows = ids.flatMap((id) => totals.get(id) ?? [])
  if (rows.length === 0) return undefined

  return rows.reduce(
    (sum, row) => ({
      entryId: entry.id,
      views: sum.views + row.views,
      previousViews: sum.previousViews + row.previousViews,
      shareIntents: sum.shareIntents + row.shareIntents,
    }),
    { entryId: entry.id, views: 0, previousViews: 0, shareIntents: 0 },
  )
}

export function EntriesPage() {
  const { collection: slug = '' } = useParams()
  const t = useT()
  const { formatDate } = useFormatters()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<EntryStatus | 'all'>('all')
  const [locale, setLocale] = useState<string>('all')

  const siteSlug = useActiveSiteSlug()
  const { site } = useActiveSite()
  const locales = site?.locales ?? []

  const collection = useQuery({
    queryKey: ['collection', siteSlug, slug],
    queryFn: () => api.collections.get(slug),
    enabled: Boolean(siteSlug),
  })

  // On a multilingual site the list is of *pieces*, not rows: one line per post, with its languages
  // beside it. Listing every translation separately showed the same article once per language and
  // made a collection look three times its size. A single-locale site has nothing to collapse, so
  // it keeps the plain row-per-entry list and pays for no extra query.
  const multilingual = locales.length > 1

  // Paged, and the page size is the reader's (#122). This list used to take the server's first
  // page and drop `nextCursor`, so a collection's twenty-first entry existed and could not be
  // reached from here.
  const entries = useKeysetPage<Entry>({
    queryKey: ['entries', siteSlug, slug, status, locale, search, multilingual],
    enabled: Boolean(siteSlug),
    fetchPage: (page) =>
      api.entries.list(slug, {
        ...page,
        ...(status === 'all' ? {} : { status }),
        ...(locale === 'all' ? {} : { locale }),
        ...(search ? { q: search } : {}),
        ...(multilingual ? { groupBy: 'post' as const } : {}),
      }),
  })

  // Traffic for the whole collection in one request, joined to the rows on screen by id, rather
  // than a lookup per row: the page turns and the filters change often, and a query per visible
  // entry would issue twenty-five of them each time. The window is fixed — see the constant.
  const traffic = useQuery({
    queryKey: ['analytics', 'entry-totals', siteSlug, slug],
    queryFn: () => api.analytics.entryTotals(slug, { days: ANALYTICS_ENTRY_COLUMN_DAYS }),
    enabled: Boolean(siteSlug && slug),
    // Analytics is not why somebody opened this page. A stale-but-instant number beside a row is a
    // better trade than the table waiting on a second request before it can be read.
    staleTime: 5 * 60 * 1000,
    // A site with no collector embedded answers 200-with-nothing, and a viewer without access to
    // analytics is not a reason to fail the entries table.
    retry: false,
  })

  const totals = new Map((traffic.data ?? []).map((row) => [row.entryId, row]))

  // Shown only where there is something to show. Three columns of zeroes on every deployment that
  // has never embedded the collector would be accurate and useless — `/analytics` is where a site
  // is told it is not collecting, and it says so properly.
  const showTraffic = totals.size > 0

  return (
    <>
      <PageHeader
        title={collection.data?.name ?? t('entries.fallbackTitle')}
        description={collection.data?.description ?? undefined}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={`/collections/${slug}/settings`}>
                <Settings2 className="size-4" />
                {t('entries.settings')}
              </Link>
            </Button>
            <Button asChild>
              <Link to={`/collections/${slug}/entries/new`}>
                <Plus className="size-4" />
                {t('entries.newEntry')}
              </Link>
            </Button>
          </>
        }
      />

      <div className="space-y-4 p-8">
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder={t('entries.searchPlaceholder')}
            value={search}
            className="max-w-xs"
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('entries.allStatuses')}</SelectItem>
              <SelectItem value="draft">{t('entries.statusDraft')}</SelectItem>
              <SelectItem value="published">{t('entries.statusPublished')}</SelectItem>
              <SelectItem value="archived">{t('entries.statusArchived')}</SelectItem>
            </SelectContent>
          </Select>
          {/* Only worth showing on a multilingual site; a single-locale site has nothing to filter. */}
          {locales.length > 1 && (
            <Select value={locale} onValueChange={setLocale}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('entries.allLocales')}</SelectItem>
                {locales.map((code) => (
                  <SelectItem key={code} value={code}>
                    {localeLabel(code)} · {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {entries.isLoading && <Skeleton className="h-64 w-full" />}

        {!entries.isLoading && entries.isEmpty && (
          <EmptyState
            title={t('entries.emptyTitle')}
            description={t('entries.emptyDescription')}
            action={
              <Button asChild>
                <Link to={`/collections/${slug}/entries/new`}>{t('entries.newEntry')}</Link>
              </Button>
            }
          />
        )}

        {/* The window has to be stated: unlabelled, "Views" reads as all-time, and an article
            published two years ago would look like it was never read. */}
        {showTraffic && !entries.isLoading && !entries.isEmpty && (
          <p className="text-muted-foreground text-xs">
            {t('entries.trafficWindow', { days: String(ANALYTICS_ENTRY_COLUMN_DAYS) })}{' '}
            <Link className="underline" to="/analytics">
              {t('entries.trafficLink')}
            </Link>
          </p>
        )}

        {!entries.isLoading && !entries.isEmpty && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('entries.colTitle')}</TableHead>
                  <TableHead className="w-32">{t('entries.colStatus')}</TableHead>
                  <TableHead className="w-32">{t('entries.colVisibility')}</TableHead>
                  <TableHead className={multilingual ? 'w-56' : 'w-20'}>
                    {multilingual ? t('entries.colLanguages') : t('entries.colLocale')}
                  </TableHead>
                  {showTraffic && (
                    <>
                      <TableHead className="w-24 text-right">{t('entries.colViews')}</TableHead>
                      <TableHead className="w-24 text-right">{t('entries.colTrend')}</TableHead>
                      <TableHead className="w-24 text-right">{t('entries.colShares')}</TableHead>
                    </>
                  )}
                  <TableHead className="w-36">{t('entries.colUpdated')}</TableHead>
                  {/* The header of the actions column is empty on purpose — the control below it
                      says what it is, and a word here would be the widest thing in the column. */}
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.rows.map((entry) => {
                  const stats = postTraffic(entry, totals)

                  return (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <Link
                          to={`/collections/${slug}/entries/${entry.slug}?locale=${entry.locale}`}
                          className="font-medium hover:underline"
                        >
                          {String(entry.data.title ?? entry.slug)}
                        </Link>
                        <p className="text-muted-foreground text-xs">/{entry.slug}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[entry.status]}>
                          {t(STATUS_LABEL[entry.status])}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {entry.visibility === 'members' ? (
                          <Badge variant="outline">
                            <Lock className="size-3" />
                            {t('entries.visMembers')}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            {t('entries.visPublic')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {multilingual ? (
                          <LocaleChips
                            collection={slug}
                            locales={locales}
                            entry={entry}
                            missingLabel={t('entries.addTranslation')}
                          />
                        ) : (
                          <span className="text-muted-foreground text-sm">{entry.locale}</span>
                        )}
                      </TableCell>
                      {showTraffic && (
                        <>
                          <TableCell className="text-right text-sm tabular-nums">
                            {/* An em dash, not a zero: this collection has traffic, but nothing was
                              recorded against this piece — which is not the same as nobody
                              reading it, because a draft has no page to be read. */}
                            {stats ? stats.views.toLocaleString() : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            {stats ? (
                              <Trend current={stats.views} previous={stats.previousViews} />
                            ) : (
                              <span className="text-muted-foreground text-sm">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {stats ? stats.shareIntents.toLocaleString() : '—'}
                          </TableCell>
                        </>
                      )}
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDate(entry.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <EntryRowActions
                          collection={slug}
                          previewPath={collection.data?.previewPath ?? null}
                          entry={entry}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <TablePagination state={entries.pagination} />
          </div>
        )}
      </div>
    </>
  )
}
