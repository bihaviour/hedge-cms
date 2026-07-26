import type { NewsletterAudience } from '@hedge/core'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { memberSites, members, newsletterSubscribers, type SiteRow } from '../db/schema'
import type { Bindings } from '../env'
import { hmac, timingSafeEqualString } from './crypto'

/** Who an unsubscribe link belongs to — a list subscriber, or a member's per-site newsletter opt-in. */
export type RecipientKind = 'subscriber' | 'member'

export interface Recipient {
  kind: RecipientKind
  id: string
  email: string
  name: string | null
}

/**
 * The unsubscribe token. Keyed on `AUTH_SECRET` and bound to the kind, site and id, so a link works
 * only for the exact recipient it was minted for and cannot be forged or pointed at another row.
 */
export function unsubscribeToken(
  env: Bindings,
  kind: RecipientKind,
  siteId: string,
  id: string,
): Promise<string> {
  return hmac(env.AUTH_SECRET, `unsub:${kind}:${siteId}:${id}`)
}

export async function verifyUnsubscribeToken(
  env: Bindings,
  kind: RecipientKind,
  siteId: string,
  id: string,
  token: string,
): Promise<boolean> {
  return timingSafeEqualString(token, await unsubscribeToken(env, kind, siteId, id))
}

export async function unsubscribeUrl(
  env: Bindings,
  site: SiteRow,
  recipient: Recipient,
): Promise<string> {
  const token = await unsubscribeToken(env, recipient.kind, site.id, recipient.id)
  const params = new URLSearchParams({
    site: site.id,
    kind: recipient.kind,
    id: recipient.id,
    token,
  })
  return `${env.PUBLIC_URL}/api/v1/newsletter/unsubscribe?${params}`
}

/**
 * The addresses a newsletter goes to, deduplicated by email. Subscribers come first, then members
 * whose per-site newsletter opt-in is still set and who are not blocked — a member who also appears
 * on the subscriber list is only mailed once.
 */
export async function resolveRecipients(
  env: Bindings,
  siteId: string,
  audience: NewsletterAudience,
): Promise<Recipient[]> {
  const db = getDb(env)
  const recipients: Recipient[] = []
  const seen = new Set<string>()

  if (audience === 'subscribers' || audience === 'both') {
    const rows = await db
      .select()
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.siteId, siteId),
          eq(newsletterSubscribers.status, 'subscribed'),
        ),
      )
    for (const row of rows) {
      const email = row.email.toLowerCase()
      if (seen.has(email)) continue
      seen.add(email)
      recipients.push({ kind: 'subscriber', id: row.id, email: row.email, name: row.name })
    }
  }

  if (audience === 'members' || audience === 'both') {
    const rows = await db
      .select({ id: members.id, email: members.email, name: members.name })
      .from(memberSites)
      .innerJoin(members, eq(members.id, memberSites.memberId))
      .where(
        and(
          eq(memberSites.siteId, siteId),
          eq(memberSites.status, 'active'),
          eq(memberSites.newsletterSubscribed, true),
        ),
      )
    for (const row of rows) {
      const email = row.email.toLowerCase()
      if (seen.has(email)) continue
      seen.add(email)
      recipients.push({ kind: 'member', id: row.id, email: row.email, name: row.name })
    }
  }

  return recipients
}
