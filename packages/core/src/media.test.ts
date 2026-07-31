import { describe, expect, test } from 'bun:test'
import { listMediaQuerySchema, matchesAccept, mediaValueOrigin, mediaValueUrl } from './index'

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

/**
 * The three origins a stored media value can have. The middle one is the reason this exists: a
 * site migrating a plain text field into a `media` field is holding `/public` paths, and reading
 * one as an R2 key silently produces a URL that resolves nowhere.
 */
describe('mediaValueOrigin', () => {
  test('an absolute URL is already resolvable', () => {
    expect(mediaValueOrigin('https://cdn.example.com/hero.png')).toBe('url')
    expect(mediaValueOrigin('HTTP://cdn.example.com/hero.png')).toBe('url')
  })

  test('a leading slash is a path into the website, not a key', () => {
    expect(mediaValueOrigin('/covers/agent-runtime.png')).toBe('site-path')
    expect(mediaValueOrigin('/hero.png')).toBe('site-path')
  })

  test('anything else is an object key, including one that looks path-like', () => {
    expect(mediaValueOrigin('blog/2026/07/photo.jpg')).toBe('key')
    expect(mediaValueOrigin('photo.jpg')).toBe('key')
  })
})

describe('mediaValueUrl', () => {
  const CMS = 'https://cms.example.com'
  const SITE = 'https://example.com'

  test('a key is served by this deployment', () => {
    expect(mediaValueUrl('blog/photo.jpg', CMS, SITE)).toBe(
      'https://cms.example.com/media/blog/photo.jpg',
    )
  })

  test('an absolute URL is never rewritten, whatever the origins are', () => {
    expect(mediaValueUrl('https://cdn.example.com/hero.png', CMS, SITE)).toBe(
      'https://cdn.example.com/hero.png',
    )
  })

  test('a site path resolves against the website, not against /media', () => {
    expect(mediaValueUrl('/covers/hero.png', CMS, SITE)).toBe('https://example.com/covers/hero.png')
  })

  test('a site path is left relative when the site records no website origin', () => {
    // Still correct for anything rendering on that website, and honestly relative for anything
    // else — where the old behaviour handed out a confidently wrong `…/media//covers/hero.png`.
    expect(mediaValueUrl('/covers/hero.png', CMS, null)).toBe('/covers/hero.png')
    expect(mediaValueUrl('/covers/hero.png', CMS)).toBe('/covers/hero.png')
  })
})
