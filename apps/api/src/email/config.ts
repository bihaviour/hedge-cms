import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type EmailConfigRow, emailConfig, emailSenders, type SiteRow } from '../db/schema'
import type { Bindings } from '../env'

/** The singleton row's id — email config is deployment-wide, so there is exactly one. */
export const EMAIL_CONFIG_ID = 'default'

/**
 * The stored sender configuration, or null when none has been saved. Best-effort: a missing or
 * unreadable config must fall back to the environment defaults rather than block a send.
 */
export async function loadEmailConfig(env: Bindings): Promise<EmailConfigRow | null> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(emailConfig)
      .where(eq(emailConfig.id, EMAIL_CONFIG_ID))
      .limit(1)
    return row ?? null
  } catch (error) {
    console.error('[email] config lookup failed, using defaults', error)
    return null
  }
}

export interface Sender {
  email: string
  name: string
  replyTo?: string
}

/**
 * A resolved sender identity — one address a message goes out as, loaded from an `email_senders`
 * row (#136). Null means "no listed sender chosen", which resolves to the global CMS sender. The
 * caller decides which row this is: a site's member sender, its newsletter sender, or a campaign's
 * own pick.
 */
export interface SenderIdentity {
  email: string
  name: string | null
  replyTo: string | null
}

/**
 * The listed sender for an id, as a `SenderIdentity`, or null. Best-effort: a lookup that finds
 * nothing — including a *deleted* sender still pointed at by a site or a campaign — resolves to
 * null, which falls back to the CMS sender rather than failing the send. This is the whole reason
 * the pointer columns are plain ids and not enforced foreign keys.
 */
export async function loadSenderIdentity(
  env: Bindings,
  id: string | null | undefined,
): Promise<SenderIdentity | null> {
  if (!id) return null
  try {
    const [row] = await getDb(env)
      .select({ email: emailSenders.email, name: emailSenders.name, replyTo: emailSenders.replyTo })
      .from(emailSenders)
      .where(eq(emailSenders.id, id))
      .limit(1)
    return row ?? null
  } catch (error) {
    console.error('[email] sender lookup failed, using CMS sender', error)
    return null
  }
}

/**
 * Who a message says it is from, resolved field by field down the levels that apply to it:
 *
 *   1. the chosen sender — a listed `email_senders` row (a site's member/newsletter sender, or a
 *      campaign's own pick), loaded by the caller into a `SenderIdentity`
 *   2. the deployment's stored email config — the global CMS sender, set on the Email tab
 *   3. `EMAIL_FROM` / `EMAIL_FROM_NAME` from the environment
 *
 * Per field rather than per level: a listed sender with an address but no display name keeps
 * inheriting the name below it. A `sender` of null is either operator email — an invite or reset,
 * which is the deployment's — or a site that has assigned no sender and so inherits the CMS one.
 */
export function resolveSender(
  env: Bindings,
  config: EmailConfigRow | null,
  sender: SenderIdentity | null,
): Sender {
  const replyTo = sender?.replyTo ?? config?.replyTo ?? undefined

  return {
    email: sender?.email ?? config?.fromEmail ?? env.EMAIL_FROM,
    name: sender?.name ?? config?.fromName ?? env.EMAIL_FROM_NAME,
    ...(replyTo ? { replyTo } : {}),
  }
}

/**
 * What a message calls *itself* — the `{{appName}}` a template renders, the eyebrow above every
 * heading, and the "you subscribed to …" in a newsletter footer. The other half of `resolveSender`:
 * that decides who the message says it is from, this decides what the body says it is, and the two
 * disagreeing is the bug this exists to stop (#129).
 *
 * **A site's email is branded as that site, never as the deployment.** A member is the audience of
 * one website; the CMS behind it is not something they have heard of, so an invite reading "Set up
 * your Hedge account" names the wrong product to the wrong person. The chosen sender's display name
 * wins when it has one, then the site's own name. There is deliberately **no fall through to
 * `APP_NAME`** for a site email: a site always has a name, so reaching the deployment here would
 * mean a site-facing email branded as the CMS, which is the whole defect.
 *
 * It follows its sender (#136): a newsletter sent from a listed address named "Mark Cuban" reads as
 * "Mark Cuban" in the body too, so the From line and the body agree by construction.
 *
 * A `site` of null is deployment email — an operator invite, a password reset, a sign-in code, a
 * review notification — and that is the deployment's to brand, for the same reason it is the
 * deployment's to send as.
 */
export function resolveBrand(
  env: Bindings,
  site: SiteRow | null,
  sender: SenderIdentity | null,
): string {
  return sender?.name || site?.name || env.APP_NAME
}
