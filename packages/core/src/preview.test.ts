import { describe, expect, test } from 'bun:test'
import {
  buildPreviewUrl,
  createPreviewTokenSchema,
  PREVIEW_TOKEN_DEFAULT_TTL_SECONDS,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  previewPathSchema,
  previewUrlSchema,
} from './preview'

describe('previewUrlSchema', () => {
  test('accepts a full origin', () => {
    expect(previewUrlSchema.safeParse('https://example.com').success).toBe(true)
  })

  test('accepts an origin with a path, for a site that previews at /api/preview', () => {
    expect(previewUrlSchema.safeParse('https://example.com/api/preview').success).toBe(true)
  })

  /** The `PUBLIC_URL` failure, repeated: a bare hostname is not a URL and produces a broken link. */
  test('rejects a value with no scheme', () => {
    expect(previewUrlSchema.safeParse('example.com').success).toBe(false)
  })

  test('rejects a trailing slash, which would double up against the path template', () => {
    expect(previewUrlSchema.safeParse('https://example.com/').success).toBe(false)
  })

  test('rejects a query string, because the token is appended as one', () => {
    expect(previewUrlSchema.safeParse('https://example.com?draft=1').success).toBe(false)
  })

  test('rejects a non-http scheme', () => {
    expect(previewUrlSchema.safeParse('javascript:alert(1)').success).toBe(false)
  })
})

describe('previewPathSchema', () => {
  test('accepts a template using the three known placeholders', () => {
    expect(previewPathSchema.safeParse('/{locale}/{collection}/{slug}').success).toBe(true)
  })

  test('accepts a template with no placeholders at all, for a single-entry collection', () => {
    expect(previewPathSchema.safeParse('/about').success).toBe(true)
  })

  test('rejects a path that does not start with a slash', () => {
    expect(previewPathSchema.safeParse('posts/{slug}').success).toBe(false)
  })

  /** A typo'd placeholder would otherwise be emitted literally into the URL and 404 quietly. */
  test('rejects an unknown placeholder', () => {
    expect(previewPathSchema.safeParse('/{collection}/{id}').success).toBe(false)
  })
})

describe('buildPreviewUrl', () => {
  const base = {
    previewUrl: 'https://example.com',
    collection: 'posts',
    slug: 'hello-world',
    locale: 'en',
    token: 'hpv1.abc.def',
  }

  test('falls back to the default shape when the collection declares no path', () => {
    expect(buildPreviewUrl({ ...base, previewPath: null })).toBe(
      'https://example.com/posts/hello-world?hedge_preview=hpv1.abc.def',
    )
  })

  test('expands every placeholder', () => {
    expect(buildPreviewUrl({ ...base, previewPath: '/{locale}/{collection}/{slug}' })).toBe(
      'https://example.com/en/posts/hello-world?hedge_preview=hpv1.abc.def',
    )
  })

  test("keeps the site's own base path", () => {
    expect(
      buildPreviewUrl({
        ...base,
        previewUrl: 'https://example.com/api/preview',
        previewPath: null,
      }),
    ).toBe('https://example.com/api/preview/posts/hello-world?hedge_preview=hpv1.abc.def')
  })
})

describe('createPreviewTokenSchema', () => {
  test('defaults the TTL rather than making every caller name one', () => {
    expect(createPreviewTokenSchema.parse({}).ttlSeconds).toBe(PREVIEW_TOKEN_DEFAULT_TTL_SECONDS)
  })

  /**
   * The ceiling is the argument, not the number: a token lands in browser history and possibly in
   * the target site's referrer, and a short life is what makes that acceptable.
   */
  test('refuses a TTL above the ceiling', () => {
    expect(
      createPreviewTokenSchema.safeParse({ ttlSeconds: PREVIEW_TOKEN_MAX_TTL_SECONDS + 1 }).success,
    ).toBe(false)
  })
})
