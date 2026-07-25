import { z } from 'zod'
import { slugSchema } from './collection'
import { localeCodeSchema } from './i18n'

export const ENTRY_STATUSES = ['draft', 'published', 'archived'] as const
export type EntryStatus = (typeof ENTRY_STATUSES)[number]

/** `members` entries are withheld from the delivery API unless the caller has a member token. */
export const ENTRY_VISIBILITIES = ['public', 'members'] as const
export type EntryVisibility = (typeof ENTRY_VISIBILITIES)[number]

/**
 * Per-entry metadata. The named fields are SEO/social overrides for the site defaults; `custom`
 * holds this entry's values for the site's custom fields, validated at the route against the
 * site's `customFields` definitions.
 */
export const entryMetadataSchema = z.object({
  metaTitle: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  canonicalUrl: z.string().max(2000).optional(),
  ogImage: z.string().max(2000).optional(),
  /** Keep this entry out of search indexes even though it is published. */
  noIndex: z.boolean().default(false),
  custom: z.record(z.string(), z.unknown()).default({}),
})

export type EntryMetadata = z.infer<typeof entryMetadataSchema>

export const entrySchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  collectionSlug: z.string(),
  slug: slugSchema,
  status: z.enum(ENTRY_STATUSES),
  visibility: z.enum(ENTRY_VISIBILITIES),
  locale: localeCodeSchema,
  data: z.record(z.string(), z.unknown()),
  metadata: entryMetadataSchema,
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Entry = z.infer<typeof entrySchema>

export const createEntrySchema = z.object({
  slug: slugSchema.optional(),
  status: z.enum(ENTRY_STATUSES).default('draft'),
  visibility: z.enum(ENTRY_VISIBILITIES).default('public'),
  /**
   * Optional, not defaulted to `'en'`: which locale a new entry lands in depends on the *site*, and
   * the site's `defaultLocale` isn't known at schema-parse time. The route fills it in when omitted
   * and rejects a locale the site doesn't publish.
   */
  locale: localeCodeSchema.optional(),
  data: z.record(z.string(), z.unknown()),
  metadata: entryMetadataSchema.optional(),
})

export type CreateEntryInput = z.infer<typeof createEntrySchema>

/**
 * Declared separately rather than as `createEntrySchema.partial()`: `.partial()` keeps the
 * `.default()` on each field, so an omitted `status` would parse as `'draft'` and silently
 * unpublish the entry instead of leaving it alone.
 */
export const updateEntrySchema = z.object({
  slug: slugSchema.optional(),
  status: z.enum(ENTRY_STATUSES).optional(),
  visibility: z.enum(ENTRY_VISIBILITIES).optional(),
  locale: localeCodeSchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: entryMetadataSchema.optional(),
})

export type UpdateEntryInput = z.infer<typeof updateEntrySchema>

export const listEntriesQuerySchema = z.object({
  status: z.enum(ENTRY_STATUSES).optional(),
  visibility: z.enum(ENTRY_VISIBILITIES).optional(),
  locale: localeCodeSchema.optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'publishedAt', 'slug']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>

/** Turn arbitrary text into a URL-safe slug. Mirrors the admin UI's live slug preview. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
}
