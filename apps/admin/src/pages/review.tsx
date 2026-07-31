import { clearedLevels } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'

/**
 * "Awaiting your review" — versions in review on the active site that this person can actually take
 * the next decision on. The server does that filtering, against the same rule the approve route
 * enforces, so this page cannot offer a row that would 403 when opened.
 *
 * Each row links into the entry editor, where the version panel does the comparing and deciding.
 * There is no second copy of that UI here: the queue's job is to say *what* is waiting.
 */
export function ReviewPage() {
  const t = useT()
  const { formatDateTime } = useFormatters()
  const siteSlug = useActiveSiteSlug()
  const [cursors, setCursors] = useState<string[]>([])

  const authority = useQuery({
    queryKey: ['review-authority', siteSlug],
    queryFn: api.review.authority,
    enabled: Boolean(siteSlug),
  })

  const queue = useQuery({
    queryKey: ['review-queue', siteSlug, cursors.at(-1) ?? null],
    queryFn: () => api.review.queue(cursors.at(-1)),
    enabled: Boolean(siteSlug),
  })

  return (
    <>
      <PageHeader title={t('review.title')} description={t('review.subtitle')} />

      <div className="space-y-4 p-8">
        {authority.data?.approvalLevel === 0 && (
          <p className="rounded border p-3 text-muted-foreground text-sm">
            {t('review.noAuthority')}
          </p>
        )}

        {queue.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : queue.data && queue.data.data.length > 0 ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('review.colVersion')}</TableHead>
                  <TableHead>{t('review.colEntry')}</TableHead>
                  <TableHead className="w-40">{t('review.colAuthor')}</TableHead>
                  <TableHead className="w-28">{t('entries.status')}</TableHead>
                  <TableHead className="w-48">{t('review.colSubmitted')}</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.data.data.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      {item.title}
                      {item.stale && (
                        <span className="ml-2 inline-flex items-center gap-1 text-amber-600 text-xs dark:text-amber-500">
                          <AlertTriangle className="size-3" /> {t('versions.stale')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {item.entryTitle ?? item.entrySlug}
                      <span className="text-xs"> · {item.collectionName}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {item.createdByName ?? t('versions.unknownAuthor')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {t('versions.cleared', {
                          cleared: clearedLevels(item.approvals),
                          required: item.requiredLevels,
                        })}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDateTime(item.submittedAt)}
                    </TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" asChild>
                        <Link
                          to={`/collections/${item.collectionSlug}/entries/${item.entrySlug}?locale=${item.locale}`}
                        >
                          {t('review.open')}
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-lg border p-8 text-center">
            <p className="font-medium">{t('review.emptyTitle')}</p>
            <p className="text-muted-foreground text-sm">{t('review.emptyDescription')}</p>
          </div>
        )}

        {queue.data?.nextCursor && (
          <Button
            variant="outline"
            onClick={() => setCursors((current) => [...current, queue.data.nextCursor!])}
          >
            {t('review.loadMore')}
          </Button>
        )}
      </div>
    </>
  )
}
