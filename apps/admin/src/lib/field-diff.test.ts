import { describe, expect, test } from 'bun:test'
import { diffFields, previewValue } from './field-diff'

describe('diffFields', () => {
  test('reports only the fields that disagree', () => {
    const changes = diffFields({ title: 'A', body: 'same' }, { title: 'B', body: 'same' })
    expect(changes.map((change) => change.name)).toEqual(['title'])
    expect(changes[0]).toMatchObject({ kind: 'changed', left: 'A', right: 'B' })
  })

  /**
   * The reading the two-writers case needs: a second writer adding a section shows as `added`, not
   * as an indistinguishable "these differ".
   */
  test('distinguishes an added field from a removed one', () => {
    expect(diffFields({}, { interview: 'text' })[0]).toMatchObject({ kind: 'added' })
    expect(diffFields({ interview: 'text' }, {})[0]).toMatchObject({ kind: 'removed' })
    expect(diffFields({ interview: '' }, { interview: 'text' })[0]).toMatchObject({ kind: 'added' })
  })

  test('compares structurally, so a re-ordered object is not a change', () => {
    expect(diffFields({ meta: { a: 1 } }, { meta: { a: 1 } })).toEqual([])
    expect(diffFields({ tags: ['a'] }, { tags: ['a', 'b'] })).toHaveLength(1)
  })

  test('lists left-hand fields first, then whatever only the right side has', () => {
    const changes = diffFields({ title: 'A' }, { extra: 'x', title: 'B' })
    expect(changes.map((change) => change.name)).toEqual(['title', 'extra'])
  })
})

describe('previewValue', () => {
  test('renders a missing or empty value as a dash', () => {
    expect(previewValue(undefined)).toBe('—')
    expect(previewValue(null)).toBe('—')
    expect(previewValue('')).toBe('—')
  })

  test('leaves strings alone and serialises everything else', () => {
    expect(previewValue('hello')).toBe('hello')
    expect(previewValue(['a'])).toBe('[\n  "a"\n]')
  })
})
