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
const WEBSITE_URL = 'https://example.com'

const resolve = (data: Record<string, unknown>) =>
  resolveMediaFields(FIELDS, data, ROWS, PUBLIC_URL, WEBSITE_URL)

describe('collectMediaKeys', () => {
  test('gathers keys across entries and fields, deduplicated', () => {
    const keys = collectMediaKeys(FIELDS, [
      { cover: 'blog/2026/07/a-photo.jpg', gallery: ['blog/2026/07/b-photo.jpg'] },
      { cover: 'blog/2026/07/a-photo.jpg' },
    ])
    expect(keys.sort()).toEqual(['blog/2026/07/a-photo.jpg', 'blog/2026/07/b-photo.jpg'])
  })

  test('ignores non-media fields, empty values, absolute URLs and site paths', () => {
    expect(
      collectMediaKeys(FIELDS, [
        { title: 'not-a-key', related: 'some-slug', cover: '', gallery: [] },
        { cover: 'https://cdn.example.com/hero.png' },
        // A `/public` path names no row in this site's library, so looking it up would be a
        // query that can only ever miss.
        { cover: '/covers/agent-runtime.png', gallery: ['/a.png', '/b.png'] },
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

  /**
   * The migration case: a collection whose `cover` used to be a text field holds paths into the
   * website's own `public/` directory. Switching the field to `media` must not turn those into
   * `…/media//covers/…`, which is a URL that resolves nowhere on either origin.
   */
  test('resolves a site path against the website, never against /media', () => {
    expect(resolve({ cover: '/covers/agent-runtime.png' })).toEqual({
      cover: {
        key: null,
        url: 'https://example.com/covers/agent-runtime.png',
        alt: null,
        width: null,
        height: null,
      },
    })
  })

  test('leaves a site path relative when the site records no website URL', () => {
    const resolved = resolveMediaFields(FIELDS, { cover: '/covers/hero.png' }, ROWS, PUBLIC_URL)
    expect(resolved).toEqual({
      cover: { key: null, url: '/covers/hero.png', alt: null, width: null, height: null },
    })
  })

  test('a multiple field mixes origins without losing order', () => {
    const resolved = resolve({
      gallery: ['/a.png', 'blog/2026/07/a-photo.jpg', 'https://cdn.example.com/c.png'],
    })
    expect(
      (resolved.gallery as { url: string; key: string | null }[]).map((item) => item.url),
    ).toEqual([
      'https://example.com/a.png',
      'https://cms.example.com/media/blog/2026/07/a-photo.jpg',
      'https://cdn.example.com/c.png',
    ])
    // `key` is what tells a consumer which of these the CMS actually holds a row for.
    expect((resolved.gallery as { key: string | null }[]).map((item) => item.key)).toEqual([
      null,
      'blog/2026/07/a-photo.jpg',
      null,
    ])
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

  test('makes a site path absolute against the website that serves it', () => {
    expect(absoluteMediaUrl('/covers/hero.png', PUBLIC_URL, WEBSITE_URL)).toBe(
      'https://example.com/covers/hero.png',
    )
  })

  test('leaves a site path alone when there is no website URL to make it absolute with', () => {
    // A relative og:image is ignored by crawlers; a confidently absolute one pointing at a CMS
    // path that 404s is worse, because nothing downstream can tell it is wrong.
    expect(absoluteMediaUrl('/covers/hero.png', PUBLIC_URL)).toBe('/covers/hero.png')
    expect(absoluteMediaUrl('/covers/hero.png', PUBLIC_URL, null)).toBe('/covers/hero.png')
  })
})
