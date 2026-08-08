import type { PageQuery, Paginated } from '@hedge/core'
import { keepPreviousData, type QueryKey, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { clientPage, DEFAULT_PAGE_SIZE, pageRange } from '@/lib/pagination'

/**
 * Paging for the admin's tables (#124). Two hooks, because the lists are two different kinds — one
 * the server pages and one it returns whole — and one `PageState` so `<TablePagination>` cannot
 * tell them apart.
 */

export { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '@/lib/pagination'

/** What the pagination bar renders from. Both hooks below produce exactly this. */
export interface PageState {
  /** Zero-based index of the page on screen. */
  page: number
  size: number
  setSize: (size: number) => void
  next: () => void
  previous: () => void
  hasNext: boolean
  hasPrevious: boolean
  /** 1-based position of the first row on screen; 0 when there are none. */
  from: number
  to: number
  /**
   * Rows matching the filters, or `undefined` where the list cannot count itself exactly — the
   * review queue is the one that cannot (see `Paginated.total`). The bar renders a range when it
   * has this and a page number when it does not, rather than inventing a denominator.
   */
  total?: number
  /** A page is in flight. The previous page stays on screen while it is, so this drives the controls. */
  isFetching: boolean
}

/**
 * A server-paged list, walked with a cursor stack.
 *
 * Pagination here is **keyset, not offset** (`.claude/rules/api-routes.md`), so there is no way to
 * jump to page 7 — a cursor names the row a page starts after, and only the pages already walked
 * have one. Hence prev/next over a trail of cursors rather than numbered pages: `trail[i]` is the
 * cursor that fetched page `i + 1`, so its length *is* the current page index.
 *
 * `queryKey` is the identity of the list being paged — its filters and the active site. When it
 * changes the trail is dropped during render rather than in an effect, so a stale cursor is never
 * sent against a filter it was not issued under.
 */
export function useKeysetPage<T>({
  queryKey,
  fetchPage,
  enabled = true,
  size: initialSize = DEFAULT_PAGE_SIZE,
}: {
  queryKey: QueryKey
  fetchPage: (query: Required<Pick<PageQuery, 'limit'>> & PageQuery) => Promise<Paginated<T>>
  enabled?: boolean
  size?: number
}): {
  rows: T[]
  total?: number
  isLoading: boolean
  isError: boolean
  /**
   * The *list* is empty, not merely this page of it. The two differ: the review queue filters a
   * page in JS and can hand back none of it while later pages hold rows, and any list can empty
   * its last page when the rows on it are deleted. Showing an empty state in either case strands
   * the reader on a page with no way back, so the pager keeps rendering and only this hides it.
   */
  isEmpty: boolean
  pagination: PageState
} {
  const identity = JSON.stringify(queryKey)
  const [state, setState] = useState({ identity, trail: [] as string[], size: initialSize })

  // Adjusting state during render, the documented React pattern for "a prop changed and this state
  // is derived from it". An effect would let one render — and one fetch — go out on the old trail.
  if (state.identity !== identity) setState({ identity, trail: [], size: state.size })

  const trail = state.identity === identity ? state.trail : []
  const cursor = trail.at(-1)

  const query = useQuery({
    queryKey: [...queryKey, state.size, cursor ?? null],
    queryFn: () => fetchPage({ limit: state.size, ...(cursor ? { cursor } : {}) }),
    enabled,
    // Hold the page being replaced on screen while the next one loads. Without it every page turn
    // empties the table and collapses its height, which reads as a bug on a fast connection.
    placeholderData: keepPreviousData,
  })

  const rows = query.data?.data ?? []
  const { from, to } = pageRange(trail.length, state.size, rows.length)
  const nextCursor = query.data?.nextCursor ?? null

  return {
    rows,
    total: query.data?.total,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: rows.length === 0 && trail.length === 0 && nextCursor === null,
    pagination: {
      page: trail.length,
      size: state.size,
      // A cursor is only meaningful under the page size it was issued for, so changing the size
      // returns to the first page rather than resuming from a cursor that now names the wrong row.
      setSize: (size) => setState((current) => ({ ...current, trail: [], size })),
      next: () =>
        setState((current) =>
          nextCursor ? { ...current, trail: [...current.trail, nextCursor] } : current,
        ),
      previous: () => setState((current) => ({ ...current, trail: current.trail.slice(0, -1) })),
      hasNext: nextCursor !== null,
      hasPrevious: trail.length > 0,
      from,
      to,
      total: query.data?.total,
      isFetching: query.isFetching,
    },
  }
}

/**
 * A list the server returns whole — users, sites, roles, API keys. Every row is already in hand, so
 * a page is a slice and the total is `rows.length`: no request, no cursor, and the same bar on
 * screen as the server-paged tables.
 */
export function useClientPage<T>(
  rows: T[],
  { size: initialSize = DEFAULT_PAGE_SIZE }: { size?: number } = {},
): { rows: T[]; isEmpty: boolean; pagination: PageState } {
  const [state, setState] = useState({ page: 0, size: initialSize })
  const slice = clientPage(rows, state.page, state.size)

  return {
    rows: slice.rows,
    isEmpty: rows.length === 0,
    pagination: {
      page: slice.page,
      size: state.size,
      setSize: (size) => setState({ page: 0, size }),
      next: () => setState((current) => ({ ...current, page: slice.page + 1 })),
      previous: () => setState((current) => ({ ...current, page: slice.page - 1 })),
      hasNext: slice.hasNext,
      hasPrevious: slice.hasPrevious,
      from: slice.from,
      to: slice.to,
      total: rows.length,
      isFetching: false,
    },
  }
}
