import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  type Media,
  type MediaTypeFilter,
} from '@hedge/core'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, MoreVertical, Pencil, Search, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { UploadQueue } from '@/components/upload-queue'
import { useMediaUploads } from '@/hooks/use-media-uploads'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { formatBytes } from '@/lib/utils'

export function MediaPage() {
  const t = useT()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const siteSlug = useActiveSiteSlug()
  const [search, setSearch] = useState('')
  const [type, setType] = useState<MediaTypeFilter | 'all'>('all')
  const [editing, setEditing] = useState<Media | null>(null)
  const [confirming, setConfirming] = useState<Media | null>(null)
  const [dragDepth, setDragDepth] = useState(0)

  const media = useInfiniteQuery({
    queryKey: ['media', siteSlug, search, type],
    queryFn: ({ pageParam }) =>
      api.media.list({
        ...(search ? { q: search } : {}),
        ...(type === 'all' ? {} : { type }),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    // The page used to drop this, so a library past the first 24 files was silently truncated.
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(siteSlug),
  })

  // Uploading is a queue rather than a mutation: several files at once, each with its own
  // progress and its own outcome. The listing is refreshed per file, so the grid fills in as they
  // land instead of all at once at the end.
  const uploads = useMediaUploads({
    onUploaded: () => queryClient.invalidateQueries({ queryKey: ['media'] }),
    onSettled: ({ uploaded, failed }) => {
      if (failed === 0) {
        toast.success(
          uploaded === 1 ? t('media.uploaded') : t('upload.doneMany', { count: uploaded }),
        )
        // Nothing to look at, so the panel gets out of the way. Failures stay on screen.
        uploads.clear()
        return
      }
      if (uploaded === 0) toast.error(t('upload.allFailed'))
      else toast.warning(t('upload.someFailed', { count: uploaded, total: uploaded + failed }))
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.media.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      setConfirming(null)
      toast.success(t('media.deleted'))
    },
    onError: (error) => toast.error(error.message),
  })

  const items = media.data?.pages.flatMap((page) => page.data) ?? []
  const isEmpty = !media.isLoading && items.length === 0

  return (
    <>
      <PageHeader
        title={t('media.title')}
        description={t('media.subtitle', { size: formatBytes(MAX_UPLOAD_BYTES) })}
        actions={
          <Button onClick={() => fileInput.current?.click()}>
            <Upload className="size-4" />
            {t('media.upload')}
          </Button>
        }
      />

      <input
        ref={fileInput}
        type="file"
        className="hidden"
        multiple
        // The deployment's own list, so the file dialog offers what the API will actually take.
        accept={ALLOWED_UPLOAD_TYPES.join(',')}
        onChange={(event) => {
          uploads.add(event.target.files)
          event.target.value = ''
        }}
      />

      {/** biome-ignore lint/a11y/noStaticElementInteractions: a drop target, with the Upload button as its keyboard equivalent */}
      <div
        className="relative space-y-6 p-8"
        onDragOver={(event) => {
          // Only a drag carrying files — dragging a selection of text over the page is not an
          // upload, and claiming it is leaves the overlay stuck open.
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragDepth((depth) => (depth === 0 ? 1 : depth))
        }}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          // Counted rather than a boolean: dragging across a child fires `dragleave` on the parent,
          // so a boolean flickers the overlay off over every grid tile.
          setDragDepth((depth) => depth + 1)
        }}
        onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragDepth(0)
          uploads.add(event.dataTransfer.files)
        }}
      >
        {dragDepth > 0 && (
          // Dimming the grid rather than tinting it: the label has to be readable, and at 5%
          // opacity it landed on top of a thumbnail and could not be read at all.
          <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center rounded-xl border-2 border-primary border-dashed bg-background/80">
            <p className="rounded-full border bg-background px-4 py-2 font-medium text-sm shadow-sm">
              {t('media.dropHere')}
            </p>
          </div>
        )}

        <UploadQueue uploads={uploads} />

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1">
            <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder={t('media.search')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select value={type} onValueChange={(value) => setType(value as MediaTypeFilter | 'all')}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('media.typeAll')}</SelectItem>
              <SelectItem value="image">{t('media.typeImage')}</SelectItem>
              <SelectItem value="video">{t('media.typeVideo')}</SelectItem>
              <SelectItem value="document">{t('media.typeDocument')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {media.isLoading && (
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[0, 1, 2, 3, 4].map((key) => (
              <Skeleton key={key} className="aspect-square" />
            ))}
          </div>
        )}

        {isEmpty &&
          (search || type !== 'all' ? (
            <EmptyState
              title={t('media.noMatchTitle')}
              description={t('media.noMatchDescription')}
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch('')
                    setType('all')
                  }}
                >
                  {t('media.clearFilters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('media.emptyTitle')}
              description={t('media.emptyDescription')}
              action={
                <Button onClick={() => fileInput.current?.click()}>{t('media.uploadFile')}</Button>
              }
            />
          ))}

        {items.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {items.map((item) => (
              <div key={item.id} className="overflow-hidden rounded-lg border">
                <div className="flex aspect-square items-center justify-center bg-muted">
                  {item.contentType.startsWith('image/') ? (
                    <img
                      src={item.url}
                      alt={item.alt ?? item.filename}
                      width={item.width ?? undefined}
                      height={item.height ?? undefined}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-muted-foreground text-xs uppercase">
                      {item.contentType.split('/')[1]}
                    </span>
                  )}
                </div>
                <div className="flex items-start justify-between gap-2 p-3">
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-medium text-sm" title={item.filename}>
                      {item.filename}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {formatBytes(item.size)}
                      {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
                    </p>
                    {/* Alt is the one field that decides whether this site is usable with a
                        screen reader, so a file missing it says so on the card. */}
                    {item.alt ? (
                      <p className="truncate text-muted-foreground text-xs" title={item.alt}>
                        {item.alt}
                      </p>
                    ) : (
                      item.contentType.startsWith('image/') && (
                        <Badge variant="outline" className="text-[10px]">
                          {t('media.noAlt')}
                        </Badge>
                      )
                    )}
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('media.actionsAria', { filename: item.filename })}
                      >
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/* Both, deliberately: the URL is what a browser fetches, the key is what
                          a media field stores, and confusing the two is the whole epic. */}
                      <DropdownMenuItem
                        onClick={() => {
                          navigator.clipboard.writeText(item.url)
                          toast.success(t('media.copiedUrl'))
                        }}
                      >
                        <Link2 className="size-4" />
                        {t('media.copyUrl')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          navigator.clipboard.writeText(item.key)
                          toast.success(t('media.copiedKey'))
                        }}
                      >
                        <Copy className="size-4" />
                        {t('media.copyKey')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setEditing(item)}>
                        <Pencil className="size-4" />
                        {t('media.editDetails')}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirming(item)}>
                        <Trash2 className="size-4" />
                        {t('common.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}

        {media.hasNextPage && (
          <div className="text-center">
            <Button
              variant="outline"
              disabled={media.isFetchingNextPage}
              onClick={() => media.fetchNextPage()}
            >
              {media.isFetchingNextPage ? t('common.loading') : t('media.loadMore')}
            </Button>
          </div>
        )}
      </div>

      <EditMediaDialog item={editing} onClose={() => setEditing(null)} />

      {/* Deleting removes an R2 object a published page may be pointing at, and used to be one
          unconfirmed click. */}
      <Dialog open={confirming !== null} onOpenChange={() => setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('media.deleteTitle', { filename: confirming?.filename ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('media.deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => confirming && remove.mutate(confirming.id)}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Alt text and filename have been writable by the API, the client and an MCP agent since they
 * were added; the one surface that could not change them was the one a person uses.
 */
function EditMediaDialog({ item, onClose }: { item: Media | null; onClose: () => void }) {
  const t = useT()
  const queryClient = useQueryClient()
  const [alt, setAlt] = useState('')
  const [filename, setFilename] = useState('')

  useEffect(() => {
    if (item) {
      setAlt(item.alt ?? '')
      setFilename(item.filename)
    }
  }, [item])

  const save = useMutation({
    mutationFn: () =>
      api.media.update(item!.id, { alt: alt.trim() || null, filename: filename.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      toast.success(t('common.saved'))
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('media.editTitle')}</DialogTitle>
          <DialogDescription>{t('media.editDescription')}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="media-filename">{t('media.filename')}</Label>
            <Input
              id="media-filename"
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="media-alt">{t('media.alt')}</Label>
            <Textarea
              id="media-alt"
              rows={3}
              placeholder={t('media.altPlaceholder')}
              value={alt}
              onChange={(event) => setAlt(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">{t('media.altHint')}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || !filename.trim()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
