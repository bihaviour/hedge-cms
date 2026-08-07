import { describe, expect, test } from 'bun:test'
import { clientPage, pageRange } from './pagination'

/**
 * The arithmetic the pagination bar prints and the client-paged tables slice with. Everything here
 * is a case that shows up as a wrong number on screen rather than as an error: an off-by-one in the
 * range, or a page index left pointing past the end of a list that shrank.
 */

describe('pageRange', () => {
  test('the first page starts at one', () => {
    expect(pageRange(0, 25, 25)).toEqual({ from: 1, to: 25 })
  })

  test('a later page counts the whole pages behind it', () => {
    expect(pageRange(2, 25, 25)).toEqual({ from: 51, to: 75 })
  })

  test('a short last page ends where its rows end', () => {
    expect(pageRange(5, 25, 12)).toEqual({ from: 126, to: 137 })
  })

  /** "Showing 1–0 of 0" is the thing this exists to stop. */
  test('an empty page is zero to zero, not one to zero', () => {
    expect(pageRange(0, 25, 0)).toEqual({ from: 0, to: 0 })
  })
})

describe('clientPage', () => {
  const rows = Array.from({ length: 7 }, (_, i) => i)

  test('slices the page asked for and reports where it sits', () => {
    expect(clientPage(rows, 1, 3)).toMatchObject({ rows: [3, 4, 5], page: 1, from: 4, to: 6 })
  })

  test('knows where it is in the list', () => {
    expect(clientPage(rows, 0, 3)).toMatchObject({ hasPrevious: false, hasNext: true })
    expect(clientPage(rows, 2, 3)).toMatchObject({ hasPrevious: true, hasNext: false })
  })

  test('one page holds everything when the size covers the list', () => {
    expect(clientPage(rows, 0, 25)).toMatchObject({
      page: 0,
      from: 1,
      to: 7,
      hasPrevious: false,
      hasNext: false,
    })
  })

  /**
   * The case the clamp is for: sitting on the last page and deleting its only row. Without it the
   * requested page is past the end and the table renders empty with no indication why.
   */
  test('a page past the end falls back to the last one that exists', () => {
    expect(clientPage(rows.slice(0, 4), 5, 3)).toMatchObject({ rows: [3], page: 1, from: 4, to: 4 })
  })

  test('an empty list is one empty page, not a negative one', () => {
    expect(clientPage([], 3, 25)).toMatchObject({
      rows: [],
      page: 0,
      from: 0,
      to: 0,
      hasPrevious: false,
      hasNext: false,
    })
  })
})
