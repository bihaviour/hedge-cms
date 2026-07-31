import type { Entry, EntryStatus } from '@hedge/core'
import { localeLabel } from '@hedge/core'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Check, FileQuestion, Search } from 'lucide-react'
import { useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const STATUS_VARIANT: Record<EntryStatus, 'default' | 'secondary' | 'outline'> = {
  published: 'default',
  draft: 'secondary',
  archived: 'outline',
}

/**
 * Picking an entry to reference, instead of remembering its slug exactly.
 *
 * A reference stores a **slug**, and a slug identifies an entry across locales — the same piece
 * of writing exists once per locale under one slug. So the picker lists the locale the editor is
 * currently in: what you see when you choose is what that locale of the site will render, and a
 * reference chosen in `en` still resolves in `id` if that translation exists. That is also why a
 * draft is offered rather than hidden — it is a real entry that simply has not published yet, and
 * the delivery API will serve nothing for it until it does, which the list says out loud.
 */
export function EntryPicker({
  open,
  onOpenChange,
  collection,
  locale,
  multiple = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  collection: string
  locale: string
  multiple?: boolean
  onConfirm: (entries: Entry[]) => void
}) {
  const t = useT()
  const siteSlug = useActiveSiteSlug()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Entry[]>([])

  const list = useInfiniteQuery({
    queryKey: ['entry-picker', siteSlug, collection, locale, search],
    queryFn: ({ pageParam }) =>
      api.entries.list(collection, {
        locale,
        ...(search ? { q: search } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open && Boolean(siteSlug),
  })

  function close() {
    setSelected([])
    setSearch('')
    onOpenChange(false)
  }

  function toggle(entry: Entry) {
    setSelected((current) => {
      const without = current.filter((chosen) => chosen.slug !== entry.slug)
      if (without.length !== current.length) return without
      return multiple ? [...current, entry] : [entry]
    })
  }

  const entries = list.data?.pages.flatMap((page) => page.data) ?? []

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('picker.chooseEntry')}</DialogTitle>
          <DialogDescription>
            {t('picker.chooseEntryDescription', {
              collection,
              locale: localeLabel(locale),
              arity: multiple ? t('picker.arityMany') : t('picker.arityOne'),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t('picker.searchEntries')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="min-h-48 flex-1 space-y-1.5 overflow-y-auto">
          {list.isLoading && [0, 1, 2].map((key) => <Skeleton key={key} className="h-14 w-full" />)}

          {!list.isLoading && entries.length === 0 && (
            <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
              <FileQuestion className="size-5 text-muted-foreground" />
              <p className="font-medium text-sm">
                {search ? t('picker.noMatch') : t('picker.noEntries', { collection })}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('picker.localeOnly', { locale: localeLabel(locale) })}
              </p>
            </div>
          )}

          {entries.map((entry) => {
            const position = selected.findIndex((chosen) => chosen.slug === entry.slug)
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => toggle(entry)}
                aria-pressed={position !== -1}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                  position !== -1 ? 'border-primary ring-2 ring-primary' : 'hover:bg-muted/50',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">
                    {String(entry.data.title ?? '') || entry.slug}
                  </p>
                  <p className="truncate font-mono text-muted-foreground text-xs">{entry.slug}</p>
                </div>
                <Badge variant={STATUS_VARIANT[entry.status]} className="capitalize">
                  {entry.status}
                </Badge>
                {position !== -1 && (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                    {multiple ? position + 1 : <Check className="size-3" />}
                  </span>
                )}
              </button>
            )
          })}

          {list.hasNextPage && (
            <div className="pt-2 text-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? t('common.loading') : t('media.loadMore')}
              </Button>
            </div>
          )}
        </div>

        {selected.some((entry) => entry.status !== 'published') && (
          <p className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs">
            {t('picker.draftWarning')}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0}
            onClick={() => {
              onConfirm(selected)
              close()
            }}
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
