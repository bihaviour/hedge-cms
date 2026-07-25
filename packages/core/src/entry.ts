import { z } from 'zod'
import { slugSchema } from './collection'

export const ENTRY_STATUSES = ['draft', 'published', 'archived'] as const
export type EntryStatus = (typeof ENTRY_STATUSES)[number]

/** `members` entries are withheld from the delivery API unless the caller has a member token. */
export const ENTRY_VISIBILITIES = ['public', 'members'] as const
export type EntryVisibility = (typeof ENTRY_VISIBILITIES)[number]

export const entrySchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  collectionSlug: z.string(),
  slug: slugSchema,
  status: z.enum(ENTRY_STATUSES),
  visibility: z.enum(ENTRY_VISIBILITIES),
  locale: z.string().min(2).max(12),
  data: z.record(z.string(), z.unknown()),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Entry = z.infer<typeof entrySchema>

export const createEntrySchema = z.object({
  slug: slugSchema.optional(),
  status: z.enum(ENTRY_STATUSES).default('draft'),
  visibility: z.enum(ENTRY_VISIBILITIES).default('public'),
  locale: z.string().min(2).max(12).default('en'),
  data: z.record(z.string(), z.unknown()),
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
  locale: z.string().min(2).max(12).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

export type UpdateEntryInput = z.infer<typeof updateEntrySchema>

export const listEntriesQuerySchema = z.object({
  status: z.enum(ENTRY_STATUSES).optional(),
  visibility: z.enum(ENTRY_VISIBILITIES).optional(),
  locale: z.string().min(2).max(12).optional(),
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
