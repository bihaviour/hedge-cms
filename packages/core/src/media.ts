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
