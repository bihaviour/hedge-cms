import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PAGE_SIZES, type PageState } from '@/hooks/use-paged-query'
import { useT } from '@/lib/i18n'

/**
 * The bar under a table: what is on screen, how much there is, and the way to the rest (#124).
 * One component for every table in the admin, fed by either hook in `use-paged-query.ts`, so a
 * server-paged list and a client-paged one are indistinguishable here.
 *
 * Render it *inside* the table's bordered container — it draws its own top rule and reads as the
 * table's last row rather than as a detached control floating under one.
 *
 * It degrades on purpose. A table that fits on one page shows its count and no controls, so a
 * three-row roles table gains a number without gaining chrome nobody can use.
 */
export function TablePagination({ state }: { state: PageState }) {
  const t = useT()
  const { total, from, to, page, size, setSize, next, previous, hasNext, hasPrevious, isFetching } =
    state

  const onlyPage = !hasNext && !hasPrevious

  // Nothing to page and nothing to count: the review queue on a single page, whose total cannot be
  // known. A bar saying "Page 1" and offering no controls is worth less than no bar.
  if (onlyPage && total === undefined) return null

  if (onlyPage) {
    return (
      <div className="border-t px-4 py-3 text-muted-foreground text-sm">
        {total === 1 ? t('pagination.rowsOne') : t('pagination.rowsMany', { total: total ?? 0 })}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
      <p className="text-muted-foreground text-sm">
        {/* A range needs a denominator. Without an exact total — the review queue — say which page
            this is instead of printing a number that is not the one it looks like. */}
        {total === undefined
          ? t('pagination.page', { page: page + 1 })
          : t('pagination.showing', { from, to, total })}
      </p>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="hidden text-muted-foreground text-sm sm:inline">
            {t('pagination.rowsPerPage')}
          </span>
          <Select value={String(size)} onValueChange={(value) => setSize(Number(value))}>
            <SelectTrigger className="w-20" size="sm" aria-label={t('pagination.rowsPerPage')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrevious || isFetching}
            onClick={previous}
          >
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">{t('pagination.previous')}</span>
          </Button>
          <Button variant="outline" size="sm" disabled={!hasNext || isFetching} onClick={next}>
            <span className="hidden sm:inline">{t('pagination.next')}</span>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
