import { describe, expect, test } from 'bun:test'
import { buildEntryValidator, fieldsSchema, roleAtLeast, slugify } from './index'

describe('slugify', () => {
  test('normalizes text into kebab-case', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('  Café  au  lait ')).toBe('cafe-au-lait')
    expect(slugify('---already--slugged---')).toBe('already-slugged')
  })
})

describe('roleAtLeast', () => {
  test('respects the role hierarchy', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true)
    expect(roleAtLeast('editor', 'admin')).toBe(false)
    expect(roleAtLeast('viewer', 'viewer')).toBe(true)
  })
})

describe('buildEntryValidator', () => {
  const fields = fieldsSchema.parse([
    { kind: 'text', name: 'title', label: 'Title', required: true, maxLength: 10 },
    { kind: 'number', name: 'rank', label: 'Rank', integer: true, min: 0 },
    {
      kind: 'select',
      name: 'tier',
      label: 'Tier',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ])

  test('accepts valid data and strips unknown keys', () => {
    const result = buildEntryValidator(fields).parse({
      title: 'Hi',
      rank: 3,
      tier: 'a',
      bogus: true,
    })
    expect(result).toEqual({ title: 'Hi', rank: 3, tier: 'a' })
  })

  test('rejects data that violates a field constraint', () => {
    const validator = buildEntryValidator(fields)
    expect(() => validator.parse({ title: 'way too long a title' })).toThrow()
    expect(() => validator.parse({ title: 'ok', rank: 1.5 })).toThrow()
    expect(() => validator.parse({ title: 'ok', tier: 'z' })).toThrow()
  })

  test('requires fields marked required', () => {
    expect(() => buildEntryValidator(fields).parse({ rank: 1 })).toThrow()
  })
})

describe('buildEntryValidator — url, email and color kinds', () => {
  const fields = fieldsSchema.parse([
    { kind: 'url', name: 'homepage', label: 'Homepage' },
    { kind: 'email', name: 'contact', label: 'Contact' },
    { kind: 'color', name: 'brand', label: 'Brand' },
  ])

  test('accepts a well-formed url, email and hex colour', () => {
    const result = buildEntryValidator(fields).parse({
      homepage: 'https://example.com',
      contact: 'name@example.com',
      brand: '#ff8800',
    })
    expect(result).toEqual({
      homepage: 'https://example.com',
      contact: 'name@example.com',
      brand: '#ff8800',
    })
  })

  test('rejects a malformed url, email or colour', () => {
    const validator = buildEntryValidator(fields)
    expect(() => validator.parse({ homepage: 'not a url' })).toThrow()
    expect(() => validator.parse({ contact: 'nope' })).toThrow()
    expect(() => validator.parse({ brand: 'red' })).toThrow()
    expect(() => validator.parse({ brand: '#fff' })).toThrow()
  })
})

describe('fieldsSchema', () => {
  test('rejects duplicate field names', () => {
    expect(() =>
      fieldsSchema.parse([
        { kind: 'text', name: 'title', label: 'A' },
        { kind: 'text', name: 'title', label: 'B' },
      ]),
    ).toThrow()
  })

  test('rejects non snake_case names', () => {
    expect(() => fieldsSchema.parse([{ kind: 'text', name: 'Title', label: 'A' }])).toThrow()
  })
})
