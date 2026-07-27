import { describe, expect, test } from 'bun:test'
import { type Field, fieldsSchema } from '@hedge/core'
import { entries } from '../db/schema'
import { decodeCursor, encodeCursor, parseEntryFilters, resolveSort } from './entry-query'

// These are the pure resolution and encoding functions — no database. The SQL they build is
// exercised end-to-end elsewhere; here the contract under test is what they accept and reject.

const COLUMNS = { publishedAt: entries.publishedAt, slug: entries.slug }

const fields = fieldsSchema.parse([
  { kind: 'date', name: 'date', label: 'Date' },
  { kind: 'number', name: 'rank', label: 'Rank' },
  {
    kind: 'select',
    name: 'tags',
    label: 'Tags',
    options: [{ value: 'a', label: 'A' }],
    multiple: true,
    creatable: true,
  },
]) as Field[]

describe('resolveSort', () => {
  test('accepts a built-in column', () => {
    expect(() => resolveSort('publishedAt', fields, COLUMNS)).not.toThrow()
  })

  test('rejects an unknown column', () => {
    expect(() => resolveSort('bogus', fields, COLUMNS)).toThrow()
  })

  test('accepts a declared field via data.<name> and field:<name>', () => {
    expect(() => resolveSort('data.date', fields, COLUMNS)).not.toThrow()
    expect(() => resolveSort('field:rank', fields, COLUMNS)).not.toThrow()
  })

  test('rejects a field the collection does not declare', () => {
    expect(() => resolveSort('data.nonexistent', fields, COLUMNS)).toThrow()
  })
})

describe('parseEntryFilters', () => {
  test('parses where[field][op] params for declared fields', () => {
    const params = new URLSearchParams(
      'sort=data.date&where[date][gte]=2020&where[tags][contains]=a',
    )
    const filters = parseEntryFilters(params, fields)
    expect(filters).toHaveLength(2)
    expect(filters).toContainEqual(expect.objectContaining({ op: 'gte', value: '2020' }))
    expect(filters).toContainEqual(expect.objectContaining({ op: 'contains', value: 'a' }))
  })

  test('ignores non-filter params and unknown operators', () => {
    const params = new URLSearchParams('limit=20&where[date][between]=x')
    expect(parseEntryFilters(params, fields)).toHaveLength(0)
  })

  test('rejects a filter on an undeclared field', () => {
    const params = new URLSearchParams('where[nope][eq]=x')
    expect(() => parseEntryFilters(params, fields)).toThrow()
  })
})

describe('cursor encoding', () => {
  test('round-trips a string value and the tie-break id', () => {
    const encoded = encodeCursor('2026-07-27', 'ent_123')
    expect(decodeCursor(encoded)).toEqual({ value: '2026-07-27', id: 'ent_123' })
  })

  test('preserves a numeric value and survives non-ASCII text', () => {
    expect(decodeCursor(encodeCursor(42, 'ent_1'))).toEqual({ value: 42, id: 'ent_1' })
    expect(decodeCursor(encodeCursor('café', 'ent_2'))).toEqual({ value: 'café', id: 'ent_2' })
  })

  test('is URL-safe — no characters that need escaping in a query string', () => {
    const encoded = encodeCursor('a value/with+slashes=', 'ent_9')
    expect(encoded).toBe(encodeURIComponent(encoded))
  })

  test('rejects a malformed cursor', () => {
    expect(() => decodeCursor('not-a-cursor!!')).toThrow()
  })
})
