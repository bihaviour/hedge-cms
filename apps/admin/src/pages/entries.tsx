import type { EntryStatus } from '@hedge/core'
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
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'

const STATUS_VARIANT: Record<EntryStatus, 'default' | 'secondary' | 'outline'> = {
  published: 'default',
  draft: 'secondary',
  archived: 'outline',
}

export function EntriesPage() {
  const { collection: slug = '' } = useParams()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<EntryStatus | 'all'>('all')

  const siteSlug = useActiveSiteSlug()

  const collection = useQuery({
    queryKey: ['collection', siteSlug, slug],
    queryFn: () => api.collections.get(slug),
    enabled: Boolean(siteSlug),
  })

  const entries = useQuery({
    queryKey: ['entries', siteSlug, slug, status, search],
    queryFn: () =>
      api.entries.list(slug, {
        ...(status === 'all' ? {} : { status }),
        ...(search ? { q: search } : {}),
      }),
    enabled: Boolean(siteSlug),
  })

  return (
    <>
      <PageHeader
        title={collection.data?.name ?? 'Entries'}
        description={collection.data?.description ?? undefined}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={`/collections/${slug}/settings`}>
                <Settings2 className="size-4" />
                Fields
              </Link>
            </Button>
            <Button asChild>
              <Link to={`/collections/${slug}/entries/new`}>
                <Plus className="size-4" />
                New entry
              </Link>
            </Button>
          </>
        }
      />

      <div className="space-y-4 p-8">
        <div className="flex gap-2">
          <Input
            placeholder="Search by slug…"
            value={search}
            className="max-w-xs"
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {entries.isLoading && <Skeleton className="h-64 w-full" />}

        {entries.data?.data.length === 0 && (
          <EmptyState
            title="No entries"
            description="Nothing here yet — create the first entry for this collection."
            action={
              <Button asChild>
                <Link to={`/collections/${slug}/entries/new`}>New entry</Link>
              </Button>
            }
          />
        )}

        {entries.data && entries.data.data.length > 0 && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="w-32">Visibility</TableHead>
                  <TableHead className="w-20">Locale</TableHead>
                  <TableHead className="w-36">Updated</TableHead>
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
                      <Badge variant={STATUS_VARIANT[entry.status]} className="capitalize">
                        {entry.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {entry.visibility === 'members' ? (
                        <Badge variant="outline">
                          <Lock className="size-3" />
                          Members
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">Public</span>
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
