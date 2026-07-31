import { z } from 'zod'
import { localeCodeSchema } from './i18n'

/**
 * Authenticated preview — seeing an unpublished entry in the website's own layout.
 *
 * Hedge is headless: it has no idea what a page looks like, so the only component that can render a
 * draft the way a reader would see it is the website itself. The CMS therefore mints a short-lived
 * token scoped to **one entry**, the admin opens the website's preview route carrying it, and the
 * website's server forwards it to the delivery API — which serves that one unpublished entry and
 * nothing else.
 *
 * A token that unlocked "this site's drafts" would, leaked in a referrer header or pasted into a
 * public page, expose the whole editorial pipeline. One collection, one slug, one locale, one
 * optional version, one expiry.
 */

/**
 * Header the website's server forwards a preview token in. Deliberately not `Authorization`: a
 * website sends its delivery key there at the same time, exactly as it does with a member token.
 */
export const PREVIEW_TOKEN_HEADER = 'x-hedge-preview'

/**
 * Query parameter the token arrives in on the website's own preview route. The website reads it
 * here and moves it into the header above, server-side — it must never reach client code, because
 * the fetch that redeems it also carries the delivery API key.
 */
export const PREVIEW_TOKEN_PARAM = 'hedge_preview'

/**
 * Thirty minutes, and a hard ceiling of four hours.
 *
 * Preview tokens are **stateless** — signed with `AUTH_SECRET`, verified without a database round
 * trip, on a path the website hits during a render. That costs revocation before expiry: a token
 * handed out cannot be taken back. The alternative, an `auth_tokens`-shaped row revocable from the
 * admin, is defensible and someone will ask for it; it buys revocation and pays a D1 read per
 * preview render. A short TTL closes most of the same gap for none of the cost, and the token
 * unlocks exactly one entry on one site — so the window is what makes it acceptable that the token
 * lands in browser history and, on the target site, potentially in a referrer.
 *
 * Raising the ceiling means meeting that argument, not just changing the number.
 */
export const PREVIEW_TOKEN_DEFAULT_TTL_SECONDS = 30 * 60
export const PREVIEW_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60

/** Where preview points when a collection declares no path of its own. */
export const DEFAULT_PREVIEW_PATH = '/{collection}/{slug}'

/** The placeholders a `previewPath` template may use. */
export const PREVIEW_PLACEHOLDERS = ['collection', 'slug', 'locale'] as const

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

/**
 * The base URL of a website's preview endpoint. The `PUBLIC_URL` rule applies for the same reason
 * it applies there — a value without a scheme is not a URL, and the failure shows up as a broken
 * link rather than as a validation error someone can act on. A path is allowed (a site may accept
 * previews at `/api/preview`); a query string is not, because the token is appended as one.
 */
export const previewUrlSchema = z.string().max(2000).refine(isPreviewOrigin, {
  message:
    'must be a full URL including the scheme, e.g. https://example.com — no trailing slash, query or fragment',
})

function isPreviewOrigin(value: string): boolean {
  if (value.endsWith('/')) return false

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.search === '' && url.hash === ''
}

/**
 * A collection's preview path template, appended to the site's `previewUrl`. A blog and a docs site
 * on the same deployment preview at different shapes, so this belongs to the collection.
 */
export const previewPathSchema = z
  .string()
  .max(500)
  .refine((value) => value.startsWith('/'), { message: 'must start with "/"' })
  .refine(
    (value) =>
      [...value.matchAll(PLACEHOLDER_PATTERN)].every((match) =>
        (PREVIEW_PLACEHOLDERS as readonly string[]).includes(match[1] as string),
      ),
    { message: 'only {collection}, {slug} and {locale} are recognised placeholders' },
  )

export const createPreviewTokenSchema = z.object({
  /** Which language variant to preview. Defaults to the site's own default locale at the route. */
  locale: localeCodeSchema.optional(),
  /**
   * Reserved for entry versioning (#59), so an approver can review *the pending version* in the
   * real layout before approving it. Carried through the token and ignored until versions exist.
   */
  versionId: z.string().max(64).optional(),
  ttlSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .max(PREVIEW_TOKEN_MAX_TTL_SECONDS)
    .default(PREVIEW_TOKEN_DEFAULT_TTL_SECONDS),
})

export type CreatePreviewTokenInput = z.infer<typeof createPreviewTokenSchema>

export const previewTokenSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  /**
   * The website URL to open, already carrying the token — null when the site has no `previewUrl`
   * configured, which is what the admin keys off to point the operator at site settings instead of
   * rendering a Preview button that would 404.
   */
  url: z.string().nullable(),
})

export type PreviewToken = z.infer<typeof previewTokenSchema>

/**
 * Expands a collection's path template against one entry. Shared by preview and by the canonical
 * URL an entry defaults to, because a collection has one page shape and both are that shape — a
 * second template for the same thing is a second thing to keep in step.
 */
export function expandEntryPath(
  template: string | null,
  entry: { collection: string; slug: string; locale: string },
): string {
  return (template ?? DEFAULT_PREVIEW_PATH)
    .replaceAll('{collection}', encodeURIComponent(entry.collection))
    .replaceAll('{slug}', encodeURIComponent(entry.slug))
    .replaceAll('{locale}', encodeURIComponent(entry.locale))
}

/**
 * The public URL of one entry on the website this site feeds — what its canonical URL defaults to.
 *
 * The origin is the site's `domain` and deliberately *not* `websiteOrigin`: that one prefers
 * `previewUrl`, which may point at a preview endpoint (`https://example.com/api/preview`) rather
 * than at the page a reader lands on. A canonical URL naming a preview endpoint is worse than no
 * canonical URL at all, so a site with no domain recorded gets null and the field stays empty.
 */
export function entryPublicUrl(input: {
  domain: string | null | undefined
  previewPath: string | null
  collection: string
  slug: string
  locale: string
}): string | null {
  if (!input.domain || !input.slug) return null
  return `https://${input.domain}${expandEntryPath(input.previewPath, input)}`
}

/**
 * Expands a collection's path template against one entry and appends the token, so the admin and
 * any other client build the same URL from the same rule.
 */
export function buildPreviewUrl(input: {
  previewUrl: string
  previewPath: string | null
  collection: string
  slug: string
  locale: string
  token: string
}): string {
  const url = new URL(`${input.previewUrl}${expandEntryPath(input.previewPath, input)}`)
  url.searchParams.set(PREVIEW_TOKEN_PARAM, input.token)
  return url.toString()
}
