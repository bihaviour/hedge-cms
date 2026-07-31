import { z } from 'zod'
import { fieldsSchema } from './fields'

export const slugSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case')

/**
 * How many approvals a version of one of a collection's entries must clear before it can be
 * published — see `entry-version.ts` for the workflow itself. `0` disables it entirely and is what
 * every collection that predates the feature carries, so a deployment that enables nothing behaves
 * exactly as it always did.
 */
export const APPROVAL_LEVELS = [0, 1, 2] as const
export type ApprovalLevels = (typeof APPROVAL_LEVELS)[number]

export const approvalLevelsSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])

export const collectionSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  /** `single` collections hold exactly one entry — useful for settings or landing pages. */
  kind: z.enum(['multiple', 'single']),
  fields: fieldsSchema,
  /**
   * How many approvals a version of one of these entries needs before it can be published. `0` — the
   * default every existing collection carries — switches the workflow off entirely, and publishing
   * stays the single `PATCH` it has always been.
   */
  approvalLevels: approvalLevelsSchema,
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
  // Optional rather than defaulted, like `fields`: a caller that says nothing gets the column's own
  // default of 0, and the create form does not have to carry a value it has no control for.
  approvalLevels: approvalLevelsSchema.optional(),
})

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>

/** Declared explicitly so omitted fields stay untouched — see the note on `updateEntrySchema`. */
export const updateCollectionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  kind: z.enum(['multiple', 'single']).optional(),
  fields: fieldsSchema.optional(),
  approvalLevels: approvalLevelsSchema.optional(),
})

export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>
