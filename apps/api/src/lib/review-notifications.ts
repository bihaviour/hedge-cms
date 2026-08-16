import { approvalLevelForSiteRole, type EntryVersion, type SiteRole } from '@hedge/core'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type SiteRow, siteUsers, users } from '../db/schema'
import { renderEmail } from '../email/render'
import { sendEmail } from '../email/send'
import type { Bindings } from '../env'
import { listRoles } from './roles'

/**
 * Telling people a version is waiting on them. Three moments earn an email: submitted for review,
 * approved, and sent back for changes.
 *
 * **These are operator emails.** `sendEmail` takes a site only for a site's *own* mail — a
 * newsletter, or anything to one site's member — precisely so no site can relabel a message the CMS
 * sends to its staff. A review notification is staff mail, so no site is passed and the sender
 * resolves to the deployment's config exactly as an invite's does.
 *
 * Per-event rather than digested: a digest needs a scheduler this deployment does not have, and at
 * the volumes a self-hosted CMS sees per-event is not noisy. Every send already lands in
 * `email_log`, so there is no separate observability to add.
 */

/** Nobody is emailed more than this per event — a runaway loop should not become a mailing list. */
const MAX_RECIPIENTS = 25

/** Deep-links the admin at the version, which is where an approver or an author needs to land. */
function versionUrl(env: Bindings, site: SiteRow, version: EntryVersion): string {
  const query = new URLSearchParams({
    locale: version.locale,
    site: site.slug,
    version: version.id,
  })
  return `${env.PUBLIC_URL}/collections/${version.collectionSlug}/entries/${version.entrySlug}?${query}`
}

/**
 * Everyone on this site who could act on a submission, minus the person who submitted it.
 *
 * Two queries, not one per user: the role catalogue resolves `sites:access_all` (an owner or admin
 * has no `site_users` row at all and would otherwise be invisible here), and one join covers the
 * granted users. Scanning every user is affordable at the scale a self-hosted CMS runs at, and the
 * alternative — silence when the only approver is the owner — is worse than the query.
 */
async function siteApprovers(
  env: Bindings,
  siteId: string,
  excludeUserId: string | null,
): Promise<{ id: string; email: string; name: string }[]> {
  const db = getDb(env)
  const reachesEverySite = new Set(
    (await listRoles(env))
      .filter((role) => role.permissions.includes('sites:access_all'))
      .map((role) => role.slug),
  )

  // The join condition carries the site, not just the user — without it a grant on *another* site
  // would answer for this one, which is the tenant boundary leaking through a notification.
  const rows = await db
    .select({ user: users, grantRole: siteUsers.role, override: siteUsers.approvalLevel })
    .from(users)
    .leftJoin(siteUsers, and(eq(siteUsers.userId, users.id), eq(siteUsers.siteId, siteId)))

  const seen = new Set<string>()
  const recipients: { id: string; email: string; name: string }[] = []

  for (const row of rows) {
    if (row.user.id === excludeUserId || seen.has(row.user.id)) continue

    // Mirrors `approvalLevelFor` in `lib/auth.ts`: the explicit override, else the site role's
    // default, and a role that reaches every site resolves to site admin — level 2.
    const level = reachesEverySite.has(row.user.role)
      ? 2
      : row.grantRole
        ? (row.override ?? approvalLevelForSiteRole(row.grantRole as SiteRole))
        : null

    if (level === null || level < 1) continue
    seen.add(row.user.id)
    recipients.push({ id: row.user.id, email: row.user.email, name: row.user.name })
    if (recipients.length >= MAX_RECIPIENTS) break
  }

  return recipients
}

export async function notifyVersionSubmitted(
  env: Bindings,
  site: SiteRow,
  version: EntryVersion,
): Promise<void> {
  const url = versionUrl(env, site, version)

  for (const approver of await siteApprovers(env, site.id, version.createdBy)) {
    await sendEmail(
      env,
      await renderEmail(env, 'version_submitted', {
        to: approver.email,
        name: approver.name,
        url,
        title: version.title,
      }),
      { templateKey: 'version_submitted' },
    )
  }
}

/** Tells the author what happened. A version with no recorded author has nobody to tell. */
export async function notifyVersionDecided(
  env: Bindings,
  version: EntryVersion,
  decision: 'approved' | 'rejected',
  comment: string | null,
): Promise<void> {
  if (!version.createdBy) return

  const [author] = await getDb(env)
    .select()
    .from(users)
    .where(eq(users.id, version.createdBy))
    .limit(1)
  if (!author) return

  const key = decision === 'approved' ? 'version_approved' : 'version_changes_requested'

  await sendEmail(
    env,
    await renderEmail(env, key, {
      to: author.email,
      name: author.name,
      url: `${env.PUBLIC_URL}/collections/${version.collectionSlug}/entries/${version.entrySlug}?locale=${version.locale}&version=${version.id}`,
      title: version.title,
      comment: comment ?? '',
    }),
    { templateKey: key },
  )
}
