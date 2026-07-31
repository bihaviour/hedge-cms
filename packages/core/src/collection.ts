import { z } from 'zod'
import { fieldsSchema } from './fields'
import { previewPathSchema } from './preview'

export const slugSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case')

export const collectionSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  /** `single` collections hold exactly one entry — useful for settings or landing pages. */
  kind: z.enum(['multiple', 'single']),
  fields: fieldsSchema,
  /**
   * Path template appended to the site's `previewUrl` to reach one entry of this collection — see
   * `preview.ts`. Null falls back to `DEFAULT_PREVIEW_PATH`; it lives on the collection because a
   * blog and a docs site on one deployment preview at different shapes.
   */
  previewPath: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Collection = z.infer<typeof collectionSchema>

export const createCollectionSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  kind: z.enum(['multiple', 'single']).default('multiple'),
  fields: fieldsSchema.optional(),
  previewPath: previewPathSchema.nullable().optional(),
})

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>

/** Declared explicitly so omitted fields stay untouched — see the note on `updateEntrySchema`. */
export const updateCollectionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  kind: z.enum(['multiple', 'single']).optional(),
  fields: fieldsSchema.optional(),
  previewPath: previewPathSchema.nullable().optional(),
})

export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>
