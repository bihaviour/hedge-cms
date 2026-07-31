import { z } from 'zod'
import { type Role, roleAtLeast } from './auth'
// `approvalLevelsSchema` lives in `collection.ts` — it is a collection *setting*, and importing it
// from here rather than the other way round is what keeps these three modules acyclic.
import { approvalLevelsSchema } from './collection'
import { entryMetadataSchema } from './entry'
import { localeCodeSchema } from './i18n'

/**
 * An entry **version** is a proposed future state of one entry — `data` plus `metadata`, authored by
 * one person, sitting *beside* the live row rather than on top of it. Several can be open at once,
 * which is what lets two people write the same article without overwriting each other.
 *
 * This is the mirror image of `entryRevisionSchema` in `entry.ts`: a revision is what an entry *was*
 * and is written automatically; a version is what it *may become* and is written deliberately. They
 * stay separate shapes because conflating them would make "restore" ambiguous.
 */

/**
 * Where a version sits in the workflow.
 *
 * - `draft` — the author is still writing. Editable.
 * - `in_review` — submitted. Frozen, because a review of a moving target is not a review.
 * - `changes_requested` — an approver sent it back. Editable again, and re-submittable.
 * - `approved` — every required level cleared. Frozen, and publishable.
 * - `published` — its content was written onto the live entry. Terminal.
 * - `discarded` — abandoned. Kept rather than deleted so the approvals recorded against it survive.
 */
export const ENTRY_VERSION_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'discarded',
] as const

export type EntryVersionStatus = (typeof ENTRY_VERSION_STATUSES)[number]

/** The statuses an author may still edit. Anything else is a decision somebody has already read. */
export const EDITABLE_VERSION_STATUSES: readonly EntryVersionStatus[] = [
  'draft',
  'changes_requested',
]

/** The level one approval satisfies. Levels are cleared in order, 1 before 2. */
export const approvalLevelSchema = z.union([z.literal(1), z.literal(2)])

/**
 * The approval authority a site role carries when no explicit level is set on the grant.
 *
 * This is the *default*, not the policy: `site_users.approvalLevel` overrides it per user per site.
 * It also answers the one case that has no `site_users` row at all — a user whose instance role
 * carries `sites:access_all` reaches every site as a site admin, and therefore resolves to level 2.
 */
export function approvalLevelForSiteRole(role: Role): number {
  if (roleAtLeast(role, 'admin')) return 2
  if (roleAtLeast(role, 'editor')) return 1
  return 0
}

/**
 * One recorded decision. Rows are never updated in place — a version's progress is *derived* from
 * them rather than duplicated into a counter, so the audit trail and the state cannot disagree.
 */
export const entryVersionApprovalSchema = z.object({
  id: z.string(),
  versionId: z.string(),
  level: approvalLevelSchema,
  decision: z.enum(['approved', 'rejected']),
  userId: z.string().nullable(),
  /** Resolved for display — an id alone would mean nothing in a review trail. */
  userName: z.string().nullable(),
  comment: z.string().nullable(),
  createdAt: z.string(),
})

export type EntryVersionApproval = z.infer<typeof entryVersionApprovalSchema>

export const entryVersionSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  /** Carried so the review inbox and the editor can link to a version without a second lookup. */
  collectionSlug: z.string(),
  entrySlug: z.string(),
  locale: localeCodeSchema,
  /** The author's own one-line summary of what this version does — "added the interview section". */
  title: z.string(),
  data: z.record(z.string(), z.unknown()),
  /** Null means "leave the live entry's metadata alone", exactly as on a revision. */
  metadata: entryMetadataSchema.nullable(),
  status: z.enum(ENTRY_VERSION_STATUSES),
  /**
   * The live entry's `updatedAt` when this version was forked. `stale` is that compared against the
   * entry now — "written against an older article", which the editor warns about rather than blocks.
   */
  baseUpdatedAt: z.string(),
  stale: z.boolean(),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  submittedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvals: z.array(entryVersionApprovalSchema),
  /** The collection's `approvalLevels` at read time, so the UI knows what this version still needs. */
  requiredLevels: approvalLevelsSchema,
})

export type EntryVersion = z.infer<typeof entryVersionSchema>

/**
 * The decisions that still count — everything since the last rejection.
 *
 * A rejection sends the whole version back to its author, so what came before it was a sign-off on
 * content that has since changed. Both the level count and the "you have already approved this"
 * check read this rather than the raw list: without it, somebody who approved before a rejection
 * would be locked out of approving the revised version they were asked to look at again.
 */
export function liveApprovals(approvals: EntryVersionApproval[]): EntryVersionApproval[] {
  let start = 0
  approvals.forEach((approval, index) => {
    if (approval.decision === 'rejected') start = index + 1
  })
  return approvals.slice(start)
}

/** The levels a version has cleared. Derived from the rows, never counted alongside them. */
export function clearedLevels(approvals: EntryVersionApproval[]): number {
  return liveApprovals(approvals).length
}

/** `data` is optional: omitted, a new version forks the live entry's current content. */
export const createEntryVersionSchema = z.object({
  title: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: entryMetadataSchema.optional(),
})

export type CreateEntryVersionInput = z.infer<typeof createEntryVersionSchema>

/** Declared separately rather than `.partial()`, for the reason given on `updateEntrySchema`. */
export const updateEntryVersionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: entryMetadataSchema.optional(),
})

export type UpdateEntryVersionInput = z.infer<typeof updateEntryVersionSchema>

/** Approving and rejecting take the same body; a rejection is the one where a comment earns its keep. */
export const reviewDecisionSchema = z.object({
  comment: z.string().max(2000).optional(),
})

export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>

export const listEntryVersionsQuerySchema = z.object({
  status: z.enum(ENTRY_VERSION_STATUSES).optional(),
})

export type ListEntryVersionsQuery = z.infer<typeof listEntryVersionsQuerySchema>

/**
 * One row of the review inbox: a version waiting on somebody, with enough of its entry to be worth
 * reading in a list. The queue is a per-site query — it never scans across tenants.
 */
export const reviewQueueItemSchema = entryVersionSchema.extend({
  /** The live entry's title field, when it has one, for a list that reads like content. */
  entryTitle: z.string().nullable(),
  collectionName: z.string(),
})

export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>

export const reviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>
