/**
 * The arithmetic behind the table pagination bar (#124), kept out of the hooks so it can be tested
 * without a DOM. `use-paged-query.ts` is the React binding; everything that can be got wrong —
 * where a page starts, what a shrinking list does to the page you are on — is here.
 */

/** The rows-per-page choices. Ceilinged at 100 because every list route caps `limit` there. */
export const PAGE_SIZES = [10, 25, 50, 100] as const

export const DEFAULT_PAGE_SIZE = 25

/**
 * Where the rows on screen sit in the whole list, 1-based and inclusive — the "1–25" of
 * "Showing 1–25 of 137". An empty page is `0`/`0` rather than `1`/`0`, so a caller never prints
 * "Showing 1–0".
 *
 * `page` counts whole pages behind this one, which is exact under keyset paging *because* every
 * page before the current one was full: the only short page a cursor walk can produce is the last.
 */
export function pageRange(
  page: number,
  size: number,
  rowCount: number,
): { from: number; to: number } {
  if (rowCount === 0) return { from: 0, to: 0 }
  const from = page * size + 1
  return { from, to: from + rowCount - 1 }
}

/**
 * One page of a list held entirely in memory.
 *
 * The clamp is the reason this is a function rather than a `slice` at the call site: deleting the
 * last row of the last page leaves the requested page past the end, and an unclamped slice answers
 * that with an empty table whose only way out is the Previous button.
 */
export function clientPage<T>(
  rows: T[],
  page: number,
  size: number,
): { rows: T[]; page: number; from: number; to: number; hasPrevious: boolean; hasNext: boolean } {
  const pageCount = Math.max(1, Math.ceil(rows.length / size))
  const clamped = Math.min(Math.max(0, page), pageCount - 1)
  const start = clamped * size
  const visible = rows.slice(start, start + size)

  return {
    rows: visible,
    page: clamped,
    ...pageRange(clamped, size, visible.length),
    hasPrevious: clamped > 0,
    hasNext: clamped < pageCount - 1,
  }
}
