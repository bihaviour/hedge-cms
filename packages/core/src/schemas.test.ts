import { describe, expect, test } from 'bun:test'
import { createEntrySchema, updateCollectionSchema, updateEntrySchema } from './index'

describe('updateEntrySchema', () => {
  test('leaves omitted fields undefined instead of applying create-time defaults', () => {
    const parsed = updateEntrySchema.parse({ data: { title: 'Edited' } })
    // A `.partial()` of createEntrySchema would yield status 'draft' here and unpublish the entry.
    expect(parsed.status).toBeUndefined()
    expect(parsed.locale).toBeUndefined()
    expect(parsed.slug).toBeUndefined()
  })

  test('still accepts explicit values', () => {
    const parsed = updateEntrySchema.parse({ status: 'archived', locale: 'id' })
    expect(parsed.status).toBe('archived')
    expect(parsed.locale).toBe('id')
  })
})

describe('createEntrySchema', () => {
  test('applies defaults on create', () => {
    const parsed = createEntrySchema.parse({ data: {} })
    expect(parsed.status).toBe('draft')
    expect(parsed.locale).toBe('en')
  })
})

describe('updateCollectionSchema', () => {
  test('does not default `kind` when omitted', () => {
    expect(updateCollectionSchema.parse({ name: 'Renamed' }).kind).toBeUndefined()
  })
})
