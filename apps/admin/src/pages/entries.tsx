import { type EntryStatus, localeLabel } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { Lock, Plus, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { EmptyState, PageHeader } from '@/components/page-header'
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

  const entries = useQuery({
    queryKey: ['entries', siteSlug, slug, status, locale, search],
    queryFn: () =>
      api.entries.list(slug, {
        ...(status === 'all' ? {} : { status }),
        ...(locale === 'all' ? {} : { locale }),
        ...(search ? { q: search } : {}),
      }),
    enabled: Boolean(siteSlug),
  })

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
                {t('entries.fields')}
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

        {entries.data?.data.length === 0 && (
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

        {entries.data && entries.data.data.length > 0 && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('entries.colTitle')}</TableHead>
                  <TableHead className="w-32">{t('entries.colStatus')}</TableHead>
                  <TableHead className="w-32">{t('entries.colVisibility')}</TableHead>
                  <TableHead className="w-20">{t('entries.colLocale')}</TableHead>
                  <TableHead className="w-36">{t('entries.colUpdated')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.data.data.map((entry) => (
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
                    <TableCell className="text-muted-foreground text-sm">{entry.locale}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(entry.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
