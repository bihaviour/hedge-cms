import { MAX_UPLOAD_BYTES, type Media, matchesAccept } from '@hedge/core'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ImageOff, Loader2, Search, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, formatBytes } from '@/lib/utils'

/**
 * Picking a file from the site's library, or uploading one without leaving the dialog — the two
 * are one action, which is the whole point: attaching an image used to mean going to /media,
 * uploading, copying the key by hand and pasting it back into a text box.
 *
 * The dialog deals in `Media` objects. Callers store `key`, because that is what a media field
 * holds; the delivery API resolves it to a URL on the way out.
 */
export function MediaPicker({
  open,
  onOpenChange,
  multiple = false,
  accept = [],
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  multiple?: boolean
  /** The field's `accept` list. Narrows both the grid and the file dialog. */
  accept?: string[]
  onConfirm: (items: Media[]) => void
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const siteSlug = useActiveSiteSlug()
  const fileInput = useRef<HTMLInputElement>(null)

  const [search, setSearch] = useState('')
  // Selection order is the stored order, so this is a list rather than a set.
  const [selected, setSelected] = useState<Media[]>([])
  const [altDrafts, setAltDrafts] = useState<Record<string, string>>({})
  const [dragging, setDragging] = useState(false)

  const library = useInfiniteQuery({
    queryKey: ['media', siteSlug, search],
    queryFn: ({ pageParam }) =>
      api.media.list({
        ...(search ? { q: search } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open && Boolean(siteSlug),
  })

  const upload = useMutation({
    mutationFn: (file: File) => api.media.upload(file),
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      // Uploading is a way of choosing, so the new file is already picked when it lands.
      setSelected((current) => (multiple ? [...current, item] : [item]))
      toast.success(t('media.uploaded'))
    },
    onError: (error) => toast.error(error.message),
  })

  /** Alt text written at pick time is saved before the caller is handed the selection. */
  const confirm = useMutation({
    mutationFn: async () => {
      const written = selected.filter((item) => (altDrafts[item.id] ?? '').trim() && !item.alt)
      const saved = await Promise.all(
        written.map((item) => api.media.update(item.id, { alt: altDrafts[item.id]!.trim() })),
      )
      const byId = new Map(saved.map((item) => [item.id, item]))
      return selected.map((item) => byId.get(item.id) ?? item)
    },
    onSuccess: (items) => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      onConfirm(items)
      close()
    },
    onError: (error) => toast.error(error.message),
  })

  function close() {
    setSelected([])
    setAltDrafts({})
    setSearch('')
    onOpenChange(false)
  }

  function toggle(item: Media) {
    setSelected((current) => {
      const without = current.filter((chosen) => chosen.id !== item.id)
      if (without.length !== current.length) return without
      return multiple ? [...current, item] : [item]
    })
  }

  function uploadFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      if (!matchesAccept(file.type, accept, file.name)) {
        toast.error(t('picker.rejectedType', { filename: file.name }))
        continue
      }
      upload.mutate(file)
      if (!multiple) break
    }
  }

  // Filtering the grid client-side keeps `accept` honest without teaching the API every
  // combination a field might declare; the API's own `type` filter is coarser on purpose.
  const items = (library.data?.pages.flatMap((page) => page.data) ?? []).filter((item) =>
    matchesAccept(item.contentType, accept, item.filename),
  )
  const needsAlt = selected.filter((item) => item.contentType.startsWith('image/') && !item.alt)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('picker.chooseMedia')}</DialogTitle>
          <DialogDescription>
            {multiple ? t('picker.chooseMediaMany') : t('picker.chooseMediaOne')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder={t('media.search')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInput.current?.click()}
            disabled={upload.isPending}
          >
            {upload.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t('media.upload')}
          </Button>
        </div>

        <input
          ref={fileInput}
          type="file"
          className="hidden"
          multiple={multiple}
          accept={accept.join(',') || undefined}
          onChange={(event) => {
            uploadFiles(event.target.files)
            event.target.value = ''
          }}
        />

        {/** biome-ignore lint/a11y/noStaticElementInteractions: a drop target, with the Upload button as its keyboard equivalent */}
        <div
          className={cn(
            'min-h-48 flex-1 overflow-y-auto rounded-lg border border-dashed p-3 transition-colors',
            dragging && 'border-primary bg-primary/5',
          )}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            uploadFiles(event.dataTransfer.files)
          }}
        >
          {library.isLoading ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {[0, 1, 2, 3].map((key) => (
                <Skeleton key={key} className="aspect-square" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
              <ImageOff className="size-5 text-muted-foreground" />
              <p className="font-medium text-sm">
                {search ? t('picker.noMatch') : t('media.emptyTitle')}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('picker.dropHint', { size: formatBytes(MAX_UPLOAD_BYTES) })}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {items.map((item) => {
                  const position = selected.findIndex((chosen) => chosen.id === item.id)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggle(item)}
                      aria-pressed={position !== -1}
                      className={cn(
                        'group relative overflow-hidden rounded-md border text-left transition-colors',
                        position !== -1
                          ? 'border-primary ring-2 ring-primary'
                          : 'hover:border-primary/40',
                      )}
                    >
                      <div className="flex aspect-square items-center justify-center bg-muted">
                        {item.contentType.startsWith('image/') ? (
                          <img
                            src={item.url}
                            alt={item.alt ?? item.filename}
                            // Intrinsic size when the upload recorded one, so the grid stops
                            // shifting as thumbnails arrive. Older rows have neither.
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
                      {position !== -1 && (
                        <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                          {multiple ? position + 1 : <Check className="size-3" />}
                        </span>
                      )}
                      <p className="truncate px-2 py-1.5 text-xs" title={item.filename}>
                        {item.filename}
                      </p>
                    </button>
                  )
                })}
              </div>

              {library.hasNextPage && (
                <div className="pt-3 text-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={library.isFetchingNextPage}
                    onClick={() => library.fetchNextPage()}
                  >
                    {library.isFetchingNextPage ? t('common.loading') : t('media.loadMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* The moment someone picks an image for a specific place is the only moment they will
            ever write good alt text, so it is asked for here rather than left to the library. */}
        {needsAlt.length > 0 && (
          <div className="max-h-40 space-y-3 overflow-y-auto rounded-lg border p-3">
            {needsAlt.map((item) => (
              <div key={item.id} className="space-y-1.5">
                <Label htmlFor={`alt-${item.id}`} className="text-xs">
                  {t('picker.altFor', { filename: item.filename })}
                </Label>
                <Input
                  id={`alt-${item.id}`}
                  placeholder={t('picker.altPlaceholder')}
                  value={altDrafts[item.id] ?? ''}
                  onChange={(event) =>
                    setAltDrafts((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                />
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0 || confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            {multiple && selected.length > 0
              ? t('picker.selectCount', { count: selected.length })
              : t('picker.select')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
