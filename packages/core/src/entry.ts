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

/**
 * One language of a post, as it appears alongside its siblings. Deliberately a summary and not a
 * whole `Entry`: this is returned for every variant of a post and rendered as a row of chips, so
 * carrying each one's `data` would make listing a post's languages cost more than reading it.
 */
export const entryTranslationSchema = z.object({
  id: z.string(),
  locale: localeCodeSchema,
  /** Per-locale, so a translation can have a URL in its own language. */
  slug: slugSchema,
  title: z.string().nullable(),
  status: z.enum(ENTRY_STATUSES),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
})

export type EntryTranslation = z.infer<typeof entryTranslationSchema>

export const entrySchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  collectionSlug: z.string(),
  /**
   * The *piece* this row is one language of. Every locale variant of a post shares it, so two rows
   * with the same group id are one post in two languages rather than two posts.
   *
   * An entry is still addressed by `(collection, slug, locale)` everywhere — this is what ties those
   * addresses together, not a replacement for them.
   */
  translationGroupId: z.string(),
  slug: slugSchema,
  status: z.enum(ENTRY_STATUSES),
  visibility: z.enum(ENTRY_VISIBILITIES),
  locale: localeCodeSchema,
  data: z.record(z.string(), z.unknown()),
  metadata: entryMetadataSchema,
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * The other languages of this post, including this one. Present only where the caller asked for a
   * post rather than a row — `groupBy=post` on the list, and the single-entry read — because it
   * costs a second query, and every other reader of an `Entry` wants the one variant it addressed.
   */
  translations: z.array(entryTranslationSchema).optional(),
})

export type Entry = z.infer<typeof entrySchema>

/**
 * A point-in-time snapshot of an entry, written before every update. `metadata` is nullable: rows
 * captured before revisions recorded it have none, and restoring one then leaves the entry's
 * metadata untouched rather than wiping it. `createdByName` is resolved for display — the id alone
 * would mean nothing in a revisions list.
 */
export const entryRevisionSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  data: z.record(z.string(), z.unknown()),
  metadata: entryMetadataSchema.nullable(),
  status: z.enum(ENTRY_STATUSES),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
})

export type EntryRevision = z.infer<typeof entryRevisionSchema>

/**
 * Pulls an entry that already exists into this post, bringing every language it already has — the
 * repair for translations that were authored as separate posts before they could be linked.
 *
 * A slug alone, with no locale: a slug names one *post* across a collection, whichever of its
 * languages it happens to be written in. Taking a locale here would suggest there is a choice of
 * post behind one slug, and there is not — the API rejects a slug that names a second one.
 */
export const attachTranslationSchema = z.object({
  slug: slugSchema,
})

export type AttachTranslationInput = z.infer<typeof attachTranslationSchema>

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
  /**
   * The slug of an existing entry this one is a translation of. With it, the new entry joins that
   * post as its version in `locale`; without it, the entry starts a post of its own — *unless* its
   * slug is already taken in this collection, in which case it joins that post, which is how
   * translations were created before this field existed.
   *
   * Naming it is what lets a translation have a slug in its own language: `hello-world` and
   * `halo-dunia` are one piece only because something said so.
   */
  translationOf: slugSchema.optional(),
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
  /**
   * `post` returns one row per *piece* — the site's default-language variant where there is one —
   * with the rest of its languages summarised in `translations`. The default keeps a row per locale
   * variant, which is what every existing caller expects and what a locale filter is for.
   *
   * Opt-in rather than the default because collapsing changes what a page of results *counts*, and
   * a caller sweeping every row (the MCP list tool, the admin's field-suggestion query) needs them
   * all, not one per post.
   */
  groupBy: z.enum(['locale', 'post']).default('locale'),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  // A built-in column (`createdAt`, `updatedAt`, `publishedAt`, `slug`) or a declared content field
  // addressed as `data.<field>` / `field:<field>`. Which fields are valid depends on the collection,
  // so the resolution — and the 400 on an undeclared one — happens at the route (`lib/entry-query.ts`).
  sort: z.string().max(96).default('updatedAt'),
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
