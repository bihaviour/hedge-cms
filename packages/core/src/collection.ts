import { z } from 'zod'
import { fieldsSchema } from './fields'

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
})

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>

/** Declared explicitly so omitted fields stay untouched — see the note on `updateEntrySchema`. */
export const updateCollectionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  kind: z.enum(['multiple', 'single']).optional(),
  fields: fieldsSchema.optional(),
})

export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>
