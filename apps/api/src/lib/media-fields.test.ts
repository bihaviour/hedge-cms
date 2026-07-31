import { describe, expect, test } from 'bun:test'
import { type Field, fieldsSchema } from '@hedge/core'
import {
  absoluteMediaUrl,
  collectMediaKeys,
  type MediaLookup,
  resolveMediaFields,
} from './media-fields'

const FIELDS: Field[] = fieldsSchema.parse([
  { kind: 'text', name: 'title', label: 'Title' },
  { kind: 'media', name: 'cover', label: 'Cover', accept: ['image/*'] },
  { kind: 'media', name: 'gallery', label: 'Gallery', multiple: true },
  { kind: 'reference', name: 'related', label: 'Related', collection: 'posts' },
]) as Field[]

const ROWS = new Map<string, MediaLookup>([
  [
    'blog/2026/07/a-photo.jpg',
    { key: 'blog/2026/07/a-photo.jpg', alt: 'A photo', width: 1200, height: 800 },
  ],
  [
    'blog/2026/07/b-photo.jpg',
    { key: 'blog/2026/07/b-photo.jpg', alt: null, width: null, height: null },
  ],
])

const PUBLIC_URL = 'https://cms.example.com'

const resolve = (data: Record<string, unknown>) =>
  resolveMediaFields(FIELDS, data, ROWS, PUBLIC_URL)

describe('collectMediaKeys', () => {
  test('gathers keys across entries and fields, deduplicated', () => {
    const keys = collectMediaKeys(FIELDS, [
      { cover: 'blog/2026/07/a-photo.jpg', gallery: ['blog/2026/07/b-photo.jpg'] },
      { cover: 'blog/2026/07/a-photo.jpg' },
    ])
    expect(keys.sort()).toEqual(['blog/2026/07/a-photo.jpg', 'blog/2026/07/b-photo.jpg'])
  })

  test('ignores non-media fields, empty values and absolute URLs', () => {
    expect(
      collectMediaKeys(FIELDS, [
        { title: 'not-a-key', related: 'some-slug', cover: '', gallery: [] },
        { cover: 'https://cdn.example.com/hero.png' },
      ]),
    ).toEqual([])
  })
})

describe('resolveMediaFields', () => {
  test('builds a URL from the key and carries the alt text and dimensions', () => {
    expect(resolve({ cover: 'blog/2026/07/a-photo.jpg' })).toEqual({
      cover: {
        key: 'blog/2026/07/a-photo.jpg',
        url: 'https://cms.example.com/media/blog/2026/07/a-photo.jpg',
        alt: 'A photo',
        width: 1200,
        height: 800,
      },
    })
  })

  test('a multiple field stays a list, in stored order, even with one item', () => {
    const resolved = resolve({
      gallery: ['blog/2026/07/b-photo.jpg', 'blog/2026/07/a-photo.jpg'],
    })
    expect(Array.isArray(resolved.gallery)).toBe(true)
    expect((resolved.gallery as { key: string | null }[]).map((item) => item.key)).toEqual([
      'blog/2026/07/b-photo.jpg',
      'blog/2026/07/a-photo.jpg',
    ])
    expect(Array.isArray(resolve({ gallery: ['blog/2026/07/a-photo.jpg'] }).gallery)).toBe(true)
  })

  test('a single field is an object, not a one-item list', () => {
    expect(Array.isArray(resolve({ cover: 'blog/2026/07/a-photo.jpg' }).cover)).toBe(false)
  })

  test('passes an absolute URL through instead of prefixing it', () => {
    expect(resolve({ cover: 'https://cdn.example.com/hero.png' })).toEqual({
      cover: {
        key: null,
        url: 'https://cdn.example.com/hero.png',
        alt: null,
        width: null,
        height: null,
      },
    })
  })

  test('still resolves a key with no row — the URL is where the CMS would serve it', () => {
    expect(resolve({ cover: 'blog/2026/07/deleted.jpg' })).toEqual({
      cover: {
        key: 'blog/2026/07/deleted.jpg',
        url: 'https://cms.example.com/media/blog/2026/07/deleted.jpg',
        alt: null,
        width: null,
        height: null,
      },
    })
  })

  test('omits a field with no value rather than emitting a null', () => {
    expect(resolve({ title: 'Just a title' })).toEqual({})
    expect(resolve({ cover: null, gallery: [] })).toEqual({})
  })

  test('resolves nothing for a collection with no media fields', () => {
    const plain = fieldsSchema.parse([{ kind: 'text', name: 'title', label: 'Title' }]) as Field[]
    expect(resolveMediaFields(plain, { title: 'x' }, ROWS, PUBLIC_URL)).toEqual({})
  })
})

/**
 * `ogImage` is the one place resolution cannot be additive: the value lands in a meta tag with
 * exactly one slot, and Open Graph rejects a relative URL.
 */
describe('absoluteMediaUrl', () => {
  test('turns a key into an absolute URL', () => {
    expect(absoluteMediaUrl('blog/2026/07/a-photo.jpg', PUBLIC_URL)).toBe(
      'https://cms.example.com/media/blog/2026/07/a-photo.jpg',
    )
  })

  test('leaves a value that is already absolute alone', () => {
    expect(absoluteMediaUrl('https://cdn.example.com/hero.png', PUBLIC_URL)).toBe(
      'https://cdn.example.com/hero.png',
    )
    expect(absoluteMediaUrl('HTTPS://cdn.example.com/hero.png', PUBLIC_URL)).toBe(
      'HTTPS://cdn.example.com/hero.png',
    )
  })

  test('passes an unset value straight through, so the tag is omitted rather than empty', () => {
    expect(absoluteMediaUrl(undefined, PUBLIC_URL)).toBeUndefined()
    expect(absoluteMediaUrl('', PUBLIC_URL)).toBe('')
  })
})
