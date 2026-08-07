import type { EmailStatus, EmailTemplateKey } from '@hedge/core'
import { getDb } from '../db/client'
import { emailLog, type SiteRow } from '../db/schema'
import type { Bindings } from '../env'
import { newId } from '../lib/id'
import { loadEmailConfig, resolveSender } from './config'
import { loggedSubject } from './redact'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface SendOptions {
  /** The system template this message came from, recorded on the log row. */
  templateKey?: EmailTemplateKey
  /**
   * The site this message belongs to — a newsletter, or an email to one of that site's members.
   * Its sender override wins over the deployment's. Leave it out for deployment email: an operator
   * invite or password reset is not a site's to relabel.
   */
  site?: SiteRow | null
  /**
   * The campaign this send belongs to, recorded on the log row. Set by `sendNewsletter` and by
   * nothing else — it is what turns the log into per-campaign delivery numbers instead of a pile of
   * rows whose only link back is a subject line two campaigns can share.
   */
  newsletterId?: string
}

/**
 * Sends through the Cloudflare Email Sending binding, and records the attempt in the email log.
 *
 * The `from` fields come from the site's override, then the stored email config, then the
 * deployment's `EMAIL_FROM` / `EMAIL_FROM_NAME` — see `resolveSender`. Sending is skipped — but
 * still logged — when the config disables it, and in development, where the binding is not wired
 * up and invite and reset links stay visible in the `wrangler dev` output instead.
 *
 * The onboarded `from` domain must be enabled first:
 *   bunx wrangler email sending enable yourdomain.com
 */
export async function sendEmail(
  env: Bindings,
  message: EmailMessage,
  options: SendOptions = {},
): Promise<void> {
  const config = await loadEmailConfig(env)
  const { replyTo, ...from } = resolveSender(env, config, options.site ?? null)

  // Sending switched off in the config: compose and log, but never hand it to the provider. Unlike
  // the development branch below, this one runs in production, so the subject is redacted here too.
  if (config?.enabled === false) {
    console.log(
      `[email] disabled — skipped to=${message.to} subject=${loggedSubject(message.subject, options.templateKey)}`,
    )
    await logEmail(env, message, options, 'skipped', 'Sending disabled in email config')
    return
  }

  // No binding in development: the link is what a developer needs, so print it and move on. The
  // resolved `from` goes with it — it is the only way to see which sender an override picked
  // without a real send.
  if (env.ENVIRONMENT !== 'production' || !env.EMAIL) {
    console.log(
      `[email] from=${from.name} <${from.email}> to=${message.to} subject=${message.subject}\n${message.text}`,
    )
    await logEmail(env, message, options, 'skipped', 'Not sent in development')
    return
  }

  try {
    await env.EMAIL.send({
      to: message.to,
      from,
      ...(replyTo ? { replyTo } : {}),
      subject: message.subject,
      html: message.html,
      text: message.text,
    })
    // `sent` means the binding accepted it, not that it reached an inbox. Cloudflare Email Sending
    // surfaces no bounce or delivery callback, so this is the ceiling of what can be claimed — which
    // is why the newsletter stats read it as "accepted".
    await logEmail(env, message, options, 'sent', null)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await logEmail(env, message, options, 'failed', detail)
    throw error
  }
}

/**
 * Records one send in the email log. Best-effort: a logging failure must never turn a delivered
 * email into a failed request, so the write is swallowed rather than propagated.
 */
async function logEmail(
  env: Bindings,
  message: EmailMessage,
  options: SendOptions,
  status: EmailStatus,
  error: string | null,
): Promise<void> {
  try {
    await getDb(env)
      .insert(emailLog)
      .values({
        id: newId('elog'),
        to: message.to,
        subject: loggedSubject(message.subject, options.templateKey),
        templateKey: options.templateKey ?? null,
        newsletterId: options.newsletterId ?? null,
        status,
        error,
      })
  } catch (logError) {
    console.error('[email] failed to write log row', logError)
  }
}
