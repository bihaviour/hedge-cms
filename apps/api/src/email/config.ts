import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type EmailConfigRow, emailConfig, type SiteRow } from '../db/schema'
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
 * Who a message says it is from, resolved field by field down three levels:
 *
 *   1. the site's own override — set by a site admin under Site settings
 *   2. the deployment's stored email config — set by an instance admin under Settings → Email
 *   3. `EMAIL_FROM` / `EMAIL_FROM_NAME` from the environment
 *
 * Per field rather than per level: a site that only wants its own display name keeps inheriting the
 * address it is allowed to send from. A `site` of null is deployment email — an operator invite or
 * password reset — which no site may relabel.
 */
export function resolveSender(
  env: Bindings,
  config: EmailConfigRow | null,
  site: SiteRow | null,
): Sender {
  const replyTo = site?.emailReplyTo ?? config?.replyTo ?? undefined

  return {
    email: site?.emailFrom ?? config?.fromEmail ?? env.EMAIL_FROM,
    name: site?.emailFromName ?? config?.fromName ?? env.EMAIL_FROM_NAME,
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
 * your Hedge account" names the wrong product to the wrong person. The site's sender display name
 * wins when it has one — an operator who set it has already said what this site's mail calls itself
 * — and its own name is the answer otherwise. There is deliberately **no fall through to
 * `APP_NAME`**: a site always has a name, so reaching the deployment here would mean a site-facing
 * email branded as the CMS, which is the whole defect.
 *
 * A `site` of null is deployment email — an operator invite, a password reset, a sign-in code, a
 * review notification — and that is the deployment's to brand, for the same reason it is the
 * deployment's to send as.
 */
export function resolveBrand(env: Bindings, site: SiteRow | null): string {
  return site?.emailFromName || site?.name || env.APP_NAME
}
