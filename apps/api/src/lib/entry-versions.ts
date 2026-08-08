import {
  type CreateEntryVersionInput,
  clearedLevels,
  EDITABLE_VERSION_STATUSES,
  type Entry,
  type EntryVersion,
  type EntryVersionApproval,
  type EntryVersionStatus,
  entryMetadataSchema,
  type ListEntryVersionsQuery,
  liveApprovals,
  type Paginated,
  type ReviewQueueItem,
  type ReviewQueueQuery,
  type UpdateEntryVersionInput,
} from '@hedge/core'
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import {
  type CollectionRow,
  collections,
  type EntryRow,
  type EntryVersionApprovalRow,
  type EntryVersionRow,
  entries,
  entryVersionApprovals,
  entryVersions,
  type SiteRow,
  users,
} from '../db/schema'
import type { Bindings } from '../env'
import { findCollection } from './collections'
import { findEntry, resolveMetadata, updateEntry, validateData } from './entries'
import { ApiError } from './errors'
import { newId } from './id'
import { notifyVersionDecided, notifyVersionSubmitted } from './review-notifications'

/**
 * Entry versions — the forward-looking set. A version is a proposed future state of one entry,
 * authored beside the live row rather than on top of it, and publishing one is what writes `entries`.
 *
 * Factored out of the HTTP route for the same reason `entries.ts` is: the REST routes and the MCP
 * tools drive identical logic. The two rules the schema cannot express live here, in the write path,
 * because a table constraint cannot see who is asking:
 *
 * - an approver may not be the version's author — the second pair of eyes is the entire point;
 * - one person may not satisfy both levels.
 *
 * `publishEntryVersion` deliberately goes back out through `updateEntry`, so the pre-publish state
 * still lands in `entry_revisions` and `publishedAt` is decided in exactly one place.
 */

function toApproval(row: EntryVersionApprovalRow, userName: string | null): EntryVersionApproval {
  return {
    id: row.id,
    versionId: row.versionId,
    level: row.level as EntryVersionApproval['level'],
    decision: row.decision,
    userId: row.userId,
    userName,
    comment: row.comment,
    createdAt: row.createdAt,
  }
}

export function toEntryVersion(
  row: EntryVersionRow,
  collection: CollectionRow,
  entry: EntryRow,
  approvals: EntryVersionApproval[],
  authorName: string | null,
): EntryVersion {
  return {
    id: row.id,
    entryId: row.entryId,
    collectionSlug: collection.slug,
    entrySlug: entry.slug,
    locale: entry.locale,
    title: row.title,
    data: row.data,
    metadata: row.metadata ? entryMetadataSchema.parse(row.metadata) : null,
    status: row.status,
    baseUpdatedAt: row.baseUpdatedAt,
    // Written against an older article. A warning the editor renders, not a reason to refuse a
    // publish: which of two writers' work wins is an editorial call, not one the CMS should make.
    //
    // Only for a version somebody can still act on. A published version *is* what the entry says
    // now, and a discarded one is not going anywhere — flagging either would be warning about a
    // decision nobody is about to take.
    stale:
      row.status !== 'published' &&
      row.status !== 'discarded' &&
      row.baseUpdatedAt < entry.updatedAt,
    createdBy: row.createdBy,
    createdByName: authorName,
    submittedAt: row.submittedAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvals,
    requiredLevels: collection.approvalLevels as EntryVersion['requiredLevels'],
  }
}

/**
 * The decisions recorded against a set of versions, oldest first, with the deciding user's name.
 * One query for the whole page rather than one per version — the review inbox lists twenty.
 */
async function loadApprovals(
  env: Bindings,
  versionIds: string[],
): Promise<Map<string, EntryVersionApproval[]>> {
  const byVersion = new Map<string, EntryVersionApproval[]>()
  if (versionIds.length === 0) return byVersion

  const rows = await getDb(env)
    .select({ approval: entryVersionApprovals, userName: users.name })
    .from(entryVersionApprovals)
    .leftJoin(users, eq(entryVersionApprovals.userId, users.id))
    .where(inArray(entryVersionApprovals.versionId, versionIds))
    .orderBy(asc(entryVersionApprovals.createdAt))

  for (const row of rows) {
    const list = byVersion.get(row.approval.versionId) ?? []
    list.push(toApproval(row.approval, row.userName))
    byVersion.set(row.approval.versionId, list)
  }
  return byVersion
}

/** One version, scoped to the entry it belongs to so an id from another entry cannot be reached. */
async function findVersion(
  env: Bindings,
  entryId: string,
  versionId: string,
): Promise<EntryVersionRow> {
  const [row] = await getDb(env)
    .select()
    .from(entryVersions)
    .where(and(eq(entryVersions.id, versionId), eq(entryVersions.entryId, entryId)))
    .limit(1)

  if (!row) throw ApiError.notFound('Version')
  return row
}

/** Resolves the collection, the entry and — where asked for — one of its versions, in one place. */
async function locate(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  locale?: string,
) {
  const collection = await findCollection(env, site.id, collectionSlug)
  const entry = await findEntry(env, collection, slug, locale ?? site.defaultLocale)
  return { collection, entry }
}

/** A version plus everything needed to render it, for the single-version reads and writes. */
async function hydrate(
  env: Bindings,
  row: EntryVersionRow,
  collection: CollectionRow,
  entry: EntryRow,
): Promise<EntryVersion> {
  const approvals = (await loadApprovals(env, [row.id])).get(row.id) ?? []
  const [author] = row.createdBy
    ? await getDb(env).select({ name: users.name }).from(users).where(eq(users.id, row.createdBy))
    : []
  return toEntryVersion(row, collection, entry, approvals, author?.name ?? null)
}

export async function listEntryVersions(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  query: ListEntryVersionsQuery = {},
  locale?: string,
): Promise<EntryVersion[]> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)

  const rows = await getDb(env)
    .select({ version: entryVersions, authorName: users.name })
    .from(entryVersions)
    .leftJoin(users, eq(entryVersions.createdBy, users.id))
    .where(
      query.status
        ? and(eq(entryVersions.entryId, entry.id), eq(entryVersions.status, query.status))
        : eq(entryVersions.entryId, entry.id),
    )
    .orderBy(desc(entryVersions.createdAt))
    .limit(50)

  const approvals = await loadApprovals(
    env,
    rows.map((row) => row.version.id),
  )

  return rows.map((row) =>
    toEntryVersion(
      row.version,
      collection,
      entry,
      approvals.get(row.version.id) ?? [],
      row.authorName,
    ),
  )
}

export async function getEntryVersion(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  versionId: string,
  locale?: string,
): Promise<EntryVersion> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)
  return hydrate(env, await findVersion(env, entry.id, versionId), collection, entry)
}

/**
 * Forks a version off the live entry. `data` omitted copies the entry as it stands right now —
 * which is what "start a new version" means, and what makes two writers both fork from one draft.
 */
export async function createEntryVersion(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  input: CreateEntryVersionInput,
  actorId: string | null,
  locale?: string,
): Promise<EntryVersion> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)

  const data = input.data ? validateData(collection, input.data) : entry.data
  const metadata = input.metadata ? resolveMetadata(site, input.metadata) : entry.metadata

  const [row] = await getDb(env)
    .insert(entryVersions)
    .values({
      id: newId('ver'),
      siteId: site.id,
      entryId: entry.id,
      title: input.title,
      data,
      metadata: metadata ?? null,
      status: 'draft',
      baseUpdatedAt: entry.updatedAt,
      createdBy: actorId,
    })
    .returning()

  return toEntryVersion(row!, collection, entry, [], null)
}

export async function updateEntryVersion(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  versionId: string,
  input: UpdateEntryVersionInput,
  locale?: string,
): Promise<EntryVersion> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)
  const existing = await findVersion(env, entry.id, versionId)

  // A version under review, already approved, or published is frozen. Editing one in review would
  // make the review meaningless — an approver signed off on content that then changed underneath
  // them — so a change means sending it back and re-submitting, which resets the levels.
  if (!EDITABLE_VERSION_STATUSES.includes(existing.status)) {
    throw ApiError.conflict(
      `This version is ${existing.status.replace('_', ' ')} and can no longer be edited`,
    )
  }

  const [row] = await getDb(env)
    .update(entryVersions)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.data !== undefined ? { data: validateData(collection, input.data) } : {}),
      ...(input.metadata !== undefined ? { metadata: resolveMetadata(site, input.metadata) } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(entryVersions.id, existing.id))
    .returning()

  return hydrate(env, row!, collection, entry)
}

/**
 * Abandons a version. It is marked `discarded` rather than deleted: the approvals recorded against
 * it are an audit trail of decisions people actually made, and deleting the row takes them with it.
 */
export async function discardEntryVersion(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  versionId: string,
  locale?: string,
): Promise<EntryVersion> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)
  const existing = await findVersion(env, entry.id, versionId)

  if (existing.status === 'published') {
    throw ApiError.conflict('A published version cannot be discarded — it is already the entry')
  }

  const [row] = await getDb(env)
    .update(entryVersions)
    .set({ status: 'discarded', updatedAt: new Date().toISOString() })
    .where(eq(entryVersions.id, existing.id))
    .returning()

  return hydrate(env, row!, collection, entry)
}

export async function submitEntryVersion(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  versionId: string,
  locale?: string,
): Promise<EntryVersion> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)
  const existing = await findVersion(env, entry.id, versionId)

  if (!EDITABLE_VERSION_STATUSES.includes(existing.status)) {
    throw ApiError.conflict(
      `Only a draft or a version sent back for changes can be submitted — this one is ${existing.status.replace('_', ' ')}`,
    )
  }

  const now = new Date().toISOString()
  const [row] = await getDb(env)
    .update(entryVersions)
    .set({ status: 'in_review', submittedAt: now, updatedAt: now })
    .where(eq(entryVersions.id, existing.id))
    .returning()

  const version = await hydrate(env, row!, collection, entry)

  // Notifying is best-effort and lives here rather than in the route, so a submission through MCP
  // reaches the same approvers a submission through the admin does. Nobody's work should fail
  // because an email could not be composed.
  await notifyVersionSubmitted(env, site, version).catch((error) =>
    console.error('[review] submit notification failed', error),
  )

  return version
}

/**
 * Records one approval or rejection.
 *
 * `approverLevel` is what the caller may approve — resolved by `approvalLevelFor` in `lib/auth.ts`,
 * which is the only place that reads a `site_users` override. The route has already refused
 * anything that is not a signed-in person; this refuses everything else:
 *
 * - the version's own author, whatever their level;
 * - somebody who has already approved this version, so one person cannot clear both levels;
 * - a level below the one being cleared next.
 */
export async function decideEntryVersion(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  versionId: string,
  decision: 'approved' | 'rejected',
  args: { userId: string; approverLevel: number; comment?: string },
  locale?: string,
): Promise<EntryVersion> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)
  const existing = await findVersion(env, entry.id, versionId)
  const current = await hydrate(env, existing, collection, entry)

  if (existing.status !== 'in_review') {
    throw ApiError.conflict(
      `Only a version in review can be decided on — this one is ${existing.status.replace('_', ' ')}`,
    )
  }

  if (existing.createdBy && existing.createdBy === args.userId) {
    throw ApiError.forbidden('You cannot review your own version')
  }

  // Only the decisions still standing: somebody who approved before a rejection is being asked to
  // look at the revised version, and must be able to.
  if (liveApprovals(current.approvals).some((a) => a.userId === args.userId)) {
    throw ApiError.forbidden(
      'You have already approved this version — a second level needs a second person',
    )
  }

  const nextLevel = (clearedLevels(current.approvals) + 1) as 1 | 2
  if (args.approverLevel < nextLevel) {
    throw ApiError.forbidden(
      `Approving at level ${nextLevel} on "${site.slug}" needs approval level ${nextLevel}; yours is ${args.approverLevel}`,
    )
  }

  const db = getDb(env)
  await db.insert(entryVersionApprovals).values({
    id: newId('apr'),
    versionId: existing.id,
    level: nextLevel,
    decision,
    userId: args.userId,
    comment: args.comment ?? null,
  })

  // The state is derived from the rows just written, never counted alongside them.
  const cleared = decision === 'approved' ? nextLevel : 0
  const status: EntryVersionStatus =
    decision === 'rejected'
      ? 'changes_requested'
      : cleared >= collection.approvalLevels
        ? 'approved'
        : 'in_review'

  const [row] = await db
    .update(entryVersions)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(entryVersions.id, existing.id))
    .returning()

  const version = await hydrate(env, row!, collection, entry)
  await notifyVersionDecided(env, version, decision, args.comment ?? null).catch((error) =>
    console.error('[review] decision notification failed', error),
  )

  return version
}

/**
 * Writes a version onto the live entry.
 *
 * Two things this deliberately does not do. It does not bypass `updateEntry` — the pre-publish
 * state has to land in `entry_revisions` like any other edit. And it does not discard the entry's
 * *other* open versions: a second writer's work outliving the first publish is the scenario this
 * whole workflow exists for. Their `baseUpdatedAt` is now stale, which is a warning, not a verdict.
 */
export async function publishEntryVersion(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  versionId: string,
  actorId: string,
  locale?: string,
): Promise<{ version: EntryVersion; entry: Entry }> {
  const { collection, entry } = await locate(env, site, collectionSlug, slug, locale)
  const existing = await findVersion(env, entry.id, versionId)
  const current = await hydrate(env, existing, collection, entry)

  if (existing.status === 'published') throw ApiError.conflict('This version is already published')
  if (existing.status === 'discarded') throw ApiError.conflict('This version was discarded')

  const cleared = clearedLevels(current.approvals)
  if (cleared < collection.approvalLevels) {
    throw ApiError.approvalRequired(
      `This version has cleared ${cleared} of the ${collection.approvalLevels} approval(s) "${collection.slug}" requires`,
    )
  }

  const published = await updateEntry(
    env,
    site,
    collectionSlug,
    slug,
    {
      data: existing.data,
      // Null metadata means the version never overrode it — leave the entry's alone, exactly as a
      // restore from an older revision does.
      ...(existing.metadata ? { metadata: entryMetadataSchema.parse(existing.metadata) } : {}),
      status: 'published',
    },
    actorId,
    locale,
    { viaApprovedVersion: true },
  )

  const now = new Date().toISOString()
  const [row] = await getDb(env)
    .update(entryVersions)
    .set({ status: 'published', publishedAt: now, updatedAt: now })
    .where(eq(entryVersions.id, existing.id))
    .returning()

  return {
    version: await hydrate(env, row!, collection, { ...entry, updatedAt: now }),
    entry: published,
  }
}

/**
 * Versions waiting on somebody, for one site.
 *
 * This is what the `(siteId, status)` index exists for: the filter is on `entry_versions` itself,
 * so the queue never becomes a scan across every site's content. Keyset paginated on the id, which
 * is timestamp-prefixed, so newest-first needs no second index.
 */
export async function listReviewQueue(
  env: Bindings,
  site: SiteRow,
  query: ReviewQueueQuery,
  reviewer: { id: string; level: number },
  // No `total`, and that is the answer rather than a gap: "waiting on *you*" is decided by
  // `canDecide` in JS, from the decisions recorded against a version and who wrote it, so no
  // `COUNT(*)` can express it. `countReviewQueue` is capped at 100 for the badge for the same
  // reason, and a number that stops at 100 must not be rendered as a total (#123).
): Promise<Paginated<ReviewQueueItem>> {
  const filters = [eq(entryVersions.siteId, site.id), eq(entryVersions.status, 'in_review')]
  if (query.cursor) filters.push(lt(entryVersions.id, query.cursor))

  const rows = await getDb(env)
    .select({
      version: entryVersions,
      entry: entries,
      collection: collections,
      authorName: users.name,
    })
    .from(entryVersions)
    .innerJoin(entries, eq(entries.id, entryVersions.entryId))
    .innerJoin(collections, eq(collections.id, entries.collectionId))
    .leftJoin(users, eq(entryVersions.createdBy, users.id))
    .where(and(...filters))
    .orderBy(desc(entryVersions.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  const approvals = await loadApprovals(
    env,
    page.map((row) => row.version.id),
  )

  const items = page.map((row) => ({
    ...toEntryVersion(
      row.version,
      row.collection,
      row.entry,
      approvals.get(row.version.id) ?? [],
      row.authorName,
    ),
    entryTitle: typeof row.entry.data.title === 'string' ? row.entry.data.title : null,
    collectionName: row.collection.name,
  }))

  return {
    // "Waiting on *you*", not "waiting on somebody": whether a version is is derived from the
    // decisions recorded against it and who wrote it, neither of which an index can hold, so it is
    // filtered here rather than in the query. The cursor still advances by row, so a page can come
    // back short — that is the honest answer, and the next cursor keeps working.
    data: items.filter((item) => canDecide(item.approvals, item.createdBy, reviewer)),
    nextCursor: hasMore ? (page.at(-1)?.version.id ?? null) : null,
  }
}

/**
 * Whether this person can take the *next* decision on a version — the same three conditions
 * `decideEntryVersion` enforces, in one function so the inbox, its badge and the route that
 * actually refuses cannot drift apart on what "waiting on you" means.
 *
 * Authorship matters as much as level here. A queue that lists your own submission is nagging you
 * about work you cannot act on, and a badge counting it never reaches zero.
 */
function canDecide(
  approvals: EntryVersionApproval[],
  createdBy: string | null,
  reviewer: { id: string; level: number },
): boolean {
  if (createdBy && createdBy === reviewer.id) return false
  if (liveApprovals(approvals).some((approval) => approval.userId === reviewer.id)) return false
  return reviewer.level >= clearedLevels(approvals) + 1
}

/**
 * How many versions on this site are waiting for review, capped so the sidebar badge is a cheap
 * count rather than a page of rows.
 */
export async function countReviewQueue(
  env: Bindings,
  site: SiteRow,
  reviewer: { id: string; level: number },
): Promise<number> {
  const rows = await getDb(env)
    .select({ id: entryVersions.id, createdBy: entryVersions.createdBy })
    .from(entryVersions)
    .where(and(eq(entryVersions.siteId, site.id), eq(entryVersions.status, 'in_review')))
    .limit(100)

  if (rows.length === 0) return 0

  // Same "waiting on you" rule as the queue itself, so the badge never promises a row the inbox
  // then filters out. Bounded at 100 above: a badge is a nudge, not a report.
  const approvals = await loadApprovals(
    env,
    rows.map((row) => row.id),
  )
  return rows.filter((row) => canDecide(approvals.get(row.id) ?? [], row.createdBy, reviewer))
    .length
}
