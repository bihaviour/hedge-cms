import { describe, expect, test } from 'bun:test'
import { listMediaQuerySchema, matchesAccept } from './index'

describe('matchesAccept', () => {
  test('an empty accept list accepts anything', () => {
    expect(matchesAccept('application/pdf', [])).toBe(true)
  })

  test('matches a wildcard, an exact type, and an extension', () => {
    expect(matchesAccept('image/png', ['image/*'])).toBe(true)
    expect(matchesAccept('application/pdf', ['image/*'])).toBe(false)

    expect(matchesAccept('image/png', ['image/png', 'image/jpeg'])).toBe(true)
    expect(matchesAccept('image/gif', ['image/png', 'image/jpeg'])).toBe(false)

    expect(matchesAccept('application/pdf', ['.pdf'], 'report.PDF')).toBe(true)
    expect(matchesAccept('application/pdf', ['.pdf'], 'report.txt')).toBe(false)
  })

  test('ignores content type parameters and casing', () => {
    expect(matchesAccept('TEXT/CSV; charset=utf-8', ['text/csv'])).toBe(true)
  })
})

describe('listMediaQuerySchema', () => {
  test('defaults to a page of 24 with no filters', () => {
    const parsed = listMediaQuerySchema.parse({})
    expect(parsed.limit).toBe(24)
    expect(parsed.q).toBeUndefined()
    expect(parsed.type).toBeUndefined()
  })

  test('coerces the limit from a query string and caps it', () => {
    expect(listMediaQuerySchema.parse({ limit: '50' }).limit).toBe(50)
    expect(listMediaQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
  })

  test('rejects a type filter it has no query for', () => {
    expect(listMediaQuerySchema.parse({ type: 'image' }).type).toBe('image')
    expect(listMediaQuerySchema.safeParse({ type: 'audio' }).success).toBe(false)
  })
})
