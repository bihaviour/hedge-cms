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
 * Which of a site's two sender identities a message uses (#134). `member` is the transactional email
 * a member receives — invite, reset, verification, sign-in link; `newsletter` is a campaign. They
 * read different columns on the site, so who is asking has to say which. Operator email passes no
 * site and no purpose — it belongs to the deployment, not to either of a site's slots.
 */
export type SenderPurpose = 'member' | 'newsletter'

/**
 * A per-message sender override, above whatever the site carries. Only a newsletter uses one — a
 * campaign that sends as its author (#134) — so it is honoured for `newsletter` and ignored
 * otherwise. Each field is independent: an override that sets only a name keeps inheriting the
 * address, exactly as the site levels do.
 */
export interface SenderOverride {
  fromEmail?: string | null
  fromName?: string | null
  replyTo?: string | null
}

/** The site columns for one purpose, so the resolver reads the right pair. */
function siteSenderFields(site: SiteRow, purpose: SenderPurpose) {
  return purpose === 'newsletter'
    ? { email: site.newsletterFrom, name: site.newsletterFromName, replyTo: site.newsletterReplyTo }
    : { email: site.emailFrom, name: site.emailFromName, replyTo: site.emailReplyTo }
}

/**
 * Who a message says it is from, resolved field by field down the levels that apply to it:
 *
 *   1. the campaign's own override — newsletters only, set on the compose screen
 *   2. the site's sender for this purpose — set by a site admin under Site settings
 *   3. the deployment's stored email config — set by an instance admin under Settings → Email
 *   4. `EMAIL_FROM` / `EMAIL_FROM_NAME` from the environment
 *
 * Per field rather than per level: a level that sets only a display name keeps inheriting the
 * address it is allowed to send from. A `site` of null is deployment email — an operator invite or
 * password reset — which no site may relabel, so `purpose` and `override` do not apply to it.
 */
export function resolveSender(
  env: Bindings,
  config: EmailConfigRow | null,
  site: SiteRow | null,
  purpose: SenderPurpose = 'member',
  override?: SenderOverride,
): Sender {
  const siteFields = site ? siteSenderFields(site, purpose) : null
  const ovr = purpose === 'newsletter' ? override : undefined

  const replyTo = ovr?.replyTo ?? siteFields?.replyTo ?? config?.replyTo ?? undefined

  return {
    email: ovr?.fromEmail ?? siteFields?.email ?? config?.fromEmail ?? env.EMAIL_FROM,
    name: ovr?.fromName ?? siteFields?.name ?? config?.fromName ?? env.EMAIL_FROM_NAME,
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
 * your Hedge account" names the wrong product to the wrong person. The sender's display name wins
 * when it has one — the campaign's override, then the site's sender for this purpose — and the
 * site's own name is the answer otherwise. There is deliberately **no fall through to `APP_NAME`**:
 * a site always has a name, so reaching the deployment here would mean a site-facing email branded
 * as the CMS, which is the whole defect.
 *
 * It follows its sender field for field (#134): a newsletter sent as `mark.cuban@acme.com` reads as
 * "Mark Cuban" if that name was set, so the From line and the body agree.
 *
 * A `site` of null is deployment email — an operator invite, a password reset, a sign-in code, a
 * review notification — and that is the deployment's to brand, for the same reason it is the
 * deployment's to send as.
 */
export function resolveBrand(
  env: Bindings,
  site: SiteRow | null,
  purpose: SenderPurpose = 'member',
  override?: SenderOverride,
): string {
  if (!site) return env.APP_NAME
  const siteFields = siteSenderFields(site, purpose)
  const overrideName = purpose === 'newsletter' ? override?.fromName : undefined
  return overrideName || siteFields.name || site.name || env.APP_NAME
}
