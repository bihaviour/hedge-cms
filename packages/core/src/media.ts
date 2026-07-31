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
