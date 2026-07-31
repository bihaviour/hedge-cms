import { describe, expect, test } from 'bun:test'
import { buildEntryValidator, type Field, fieldsSchema } from './index'

const parse = (fields: unknown[]) => fieldsSchema.parse(fields) as Field[]

/**
 * The admin used to join a multiple field's values with commas and emit one string, which these
 * validators reject — so declaring a multiple media or reference field and saving it always
 * failed, with the error attached to the field rather than to the control that produced it. Both
 * shapes are pinned here because that broke silently once.
 */
describe('buildEntryValidator: multiple vs single', () => {
  for (const kind of ['media', 'reference'] as const) {
    const single = parse([
      { kind, name: 'thing', label: 'Thing', collection: 'posts', multiple: false },
    ])
    const many = parse([
      { kind, name: 'thing', label: 'Thing', collection: 'posts', multiple: true },
    ])

    test(`a single ${kind} field takes a string, not a list`, () => {
      expect(buildEntryValidator(single).safeParse({ thing: 'a-value' }).success).toBe(true)
      expect(buildEntryValidator(single).safeParse({ thing: ['a-value'] }).success).toBe(false)
    })

    test(`a multiple ${kind} field takes a list, not a comma-joined string`, () => {
      expect(buildEntryValidator(many).safeParse({ thing: ['one', 'two'] }).success).toBe(true)
      expect(buildEntryValidator(many).safeParse({ thing: 'one,two' }).success).toBe(false)
      expect(buildEntryValidator(many).safeParse({ thing: [] }).success).toBe(true)
    })

    test(`an optional ${kind} field accepts null when nothing is chosen`, () => {
      expect(buildEntryValidator(single).safeParse({ thing: null }).success).toBe(true)
      expect(buildEntryValidator(single).safeParse({}).success).toBe(true)
    })
  }

  test('a required media field still has to be filled in', () => {
    const fields = parse([{ kind: 'media', name: 'cover', label: 'Cover', required: true }])
    expect(buildEntryValidator(fields).safeParse({ cover: 'blog/photo.jpg' }).success).toBe(true)
    expect(buildEntryValidator(fields).safeParse({ cover: null }).success).toBe(false)
    expect(buildEntryValidator(fields).safeParse({ cover: '' }).success).toBe(false)
  })

  test('media fields keep their accept list and reference fields their collection', () => {
    const [media] = parse([
      { kind: 'media', name: 'cover', label: 'Cover', accept: ['image/*'] },
    ]) as [Extract<Field, { kind: 'media' }>]
    expect(media.accept).toEqual(['image/*'])
    // Defaults, so a field declared before these options existed still parses.
    expect(media.multiple).toBe(false)

    const [reference] = parse([
      { kind: 'reference', name: 'related', label: 'Related', collection: 'posts' },
    ]) as [Extract<Field, { kind: 'reference' }>]
    expect(reference.collection).toBe('posts')
    expect(reference.multiple).toBe(false)
  })
})
