import { z } from 'zod'

export const mediaSchema = z.object({
  id: z.string(),
  /** Object key inside the R2 bucket. */
  key: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  alt: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
})

export type Media = z.infer<typeof mediaSchema>

export const updateMediaSchema = z.object({
  alt: z.string().max(500).nullable().optional(),
  filename: z.string().min(1).max(255).optional(),
})

export type UpdateMediaInput = z.infer<typeof updateMediaSchema>

/**
 * Upper bound on an upload sent as base64 *inside* a request body, well below `MAX_UPLOAD_BYTES`.
 *
 * The MCP `upload_media` tool accepts two sources and they are deliberately not equals. A `url` is
 * fetched and streamed into R2 and costs a model's context window nothing, so it carries the full
 * 25 MB. Base64 arrives through the context window itself, at four bytes per three, and exists only
 * for content that has no URL because the model just produced it — a generated SVG, a small chart.
 * A cap low enough to make that the obvious reading is the point: the refusal above it names `url`.
 */
export const MAX_INLINE_UPLOAD_BYTES = 1024 * 1024

/**
 * Arguments for uploading media through MCP. Exactly one source: `url` or `data`.
 *
 * There is no REST schema to reuse here — `POST /api/v1/media` takes a multipart body, which has no
 * zod schema at all — so this is the one place an MCP tool defines its own arguments. It still lives
 * in core rather than in the tool module, because everything downstream of it (the size cap, the
 * allowed content types) is defined here and the two must not drift.
 */
export const uploadMediaSchema = z
  .object({
    url: z.url().optional(),
    /** Base64, with or without a `data:` prefix — a model writes it both ways. */
    data: z.string().min(1).optional(),
    filename: z.string().min(1).max(255).optional(),
    alt: z.string().max(500).optional(),
    /**
     * Only consulted for `data`. A fetched URL's type comes from the *response*, never from the
     * caller: trusting a caller's word about it would let an allowed type be claimed for anything.
     */
    contentType: z.string().min(1).max(255).optional(),
  })
  .refine((input) => Boolean(input.url) !== Boolean(input.data), {
    message: 'Provide exactly one of "url" or "data"',
  })

export type UploadMediaInput = z.infer<typeof uploadMediaSchema>

/**
 * Where a `media` field's stored value lives, which is what decides how to turn it into a URL.
 *
 * Two origins were understood already — an R2 key, and an absolute URL pasted in by hand. The
 * third is the one every site migrating an existing text field into a `media` field actually
 * holds: a path into the *website's own* static directory, `/covers/photo.png`. It is not a key,
 * and prefixing it as one produces `…/media//covers/photo.png`, a URL that resolves nowhere and
 * that no consumer can tell apart from a real one.
 *
 * The distinction is here rather than in either app because both sides answer it and they must
 * answer it identically: the admin to render a thumbnail, the delivery API to resolve the value.
 */
export type MediaValueOrigin =
  /** Absolute, and therefore already resolvable by anyone. Passed through untouched. */
  | 'url'
  /** Root-relative, served by the website itself — resolvable against the website's origin. */
  | 'site-path'
  /** An object key in this deployment's R2 bucket, served at `/media/<key>`. */
  | 'key'

export function mediaValueOrigin(value: string): MediaValueOrigin {
  if (/^https?:\/\//i.test(value)) return 'url'
  // A leading slash is the whole test, and it is unambiguous: R2 keys as this CMS writes them
  // never start with one (`newMediaKey` builds `<prefix>/<id>-<name>`), so no key can be read as
  // a site path by accident, and a site path is exactly how a static file is written in HTML.
  if (value.startsWith('/')) return 'site-path'
  return 'key'
}

/**
 * Where a site's *own* static files are served from — the origin a `/public` path resolves
 * against. A site records this twice, for two other reasons, and neither is a settable "website
 * URL": `previewUrl` is a full origin and the more deliberate of the two, so it wins; `domain` is
 * the hostname the delivery API already matches a request's `Host` against, which makes it the
 * website by definition. Null when a site has said neither, and no origin is invented.
 */
export function websiteOrigin(site: {
  domain?: string | null
  previewUrl?: string | null
}): string | null {
  if (site.previewUrl) return site.previewUrl
  return site.domain ? `https://${site.domain}` : null
}

/**
 * The URL a stored media value should be fetched from. `mediaOrigin` is this deployment's own
 * origin (where `/media/<key>` is served); `websiteOrigin` is the site's website, needed only
 * for a site path and null when the site has not recorded one — in which case the path is left
 * as it is, still correct for anything rendering on that website and honestly relative for
 * anything that is not.
 */
export function mediaValueUrl(
  value: string,
  mediaOrigin: string,
  websiteOrigin?: string | null,
): string {
  switch (mediaValueOrigin(value)) {
    case 'url':
      return value
    case 'site-path':
      return websiteOrigin ? `${websiteOrigin}${value}` : value
    case 'key':
      return `${mediaOrigin}/media/${value}`
  }
}

/**
 * What a `media` field's stored key becomes on the delivery API.
 *
 * Content stores the key, not the URL: a stored URL bakes the deployment's origin into every
 * entry and is wrong the day the CMS moves domain, with no migration that can reliably find
 * them all. The key is the portable value — so the URL is built at the boundary, where the
 * origin is known, and handed over alongside the alt text and dimensions the CMS already holds.
 *
 * `key` is null when the value was not this deployment's to serve — an absolute URL, or a path
 * into the website's own static directory. Both still resolve to a `url`; neither has a row here,
 * so neither carries alt text or dimensions. See `mediaValueOrigin`.
 */
export const resolvedMediaSchema = z.object({
  key: z.string().nullable(),
  url: z.string(),
  alt: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
})

export type ResolvedMedia = z.infer<typeof resolvedMediaSchema>

/**
 * How a media listing is narrowed by kind. `document` is defined as "neither image nor video" —
 * the long tail of PDFs, CSVs and JSON — so a new allowed upload type lands in it automatically
 * instead of falling out of every filter.
 */
export const MEDIA_TYPE_FILTERS = ['image', 'video', 'document'] as const
export type MediaTypeFilter = (typeof MEDIA_TYPE_FILTERS)[number]

/**
 * Mirrors `listEntriesQuerySchema`'s shape so the two listings behave alike, and is shared by the
 * REST route and the `list_media` MCP tool so the two surfaces cannot drift.
 */
export const listMediaQuerySchema = z.object({
  /** Matches filename and alt text — alt is often the only human-written description a file has. */
  q: z.string().max(200).optional(),
  type: z.enum(MEDIA_TYPE_FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().optional(),
})

export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>

/**
 * Does a file's content type satisfy a media field's `accept` list? An empty list accepts
 * everything. Entries are either a full type (`image/png`), a wildcard (`image/*`), or a bare
 * extension (`.pdf`) — the three things a person writing a field definition actually types.
 */
export function matchesAccept(contentType: string, accept: string[], filename = ''): boolean {
  if (accept.length === 0) return true
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  const name = filename.toLowerCase()

  return accept.some((raw) => {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) return false
    if (pattern.startsWith('.')) return name.endsWith(pattern)
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1))
    return type === pattern
  })
}

/** Upper bound for a single upload. Workers cap request bodies at 100 MB on paid plans. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const ALLOWED_UPLOAD_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'video/mp4',
  'text/plain',
  'text/csv',
  'application/json',
] as const

export function isAllowedUploadType(contentType: string): boolean {
  return (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(contentType.split(';')[0]!.trim())
}
