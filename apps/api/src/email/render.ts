import {
  DEFAULT_EMAIL_TEMPLATES,
  type EmailTemplateContent,
  type EmailTemplateKey,
} from '@hedge/core'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { emailTemplates } from '../db/schema'
import type { Bindings } from '../env'
import type { EmailMessage } from './send'

/** The variables every template renders from. `appName` comes from the deployment, the rest per send. */
export interface TemplateVariables {
  to: string
  name: string
  url: string
}

/**
 * The branded shell every email renders into. Only the heading, body and (optional) call-to-action
 * change between templates — the card, the app name eyebrow and the "paste this link" fallback are
 * fixed so a customised template cannot break the layout.
 */
export function layout(
  appName: string,
  heading: string,
  body: string,
  cta?: { url: string; label: string },
) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f7;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:32px">
          <tr><td>
            <p style="margin:0 0 24px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">${appName}</p>
            <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4">${heading}</h1>
            <div style="font-size:15px;line-height:1.6;color:#3f3f46">${body}</div>
            ${
              cta
                ? `<p style="margin:28px 0 0"><a href="${cta.url}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500">${cta.label}</a></p>
            <p style="margin:20px 0 0;font-size:13px;color:#71717a">Or paste this link into your browser:<br><span style="word-break:break-all">${cta.url}</span></p>`
                : ''
            }
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}

/**
 * A newsletter message: the author's HTML body wrapped in the branded card, with a required
 * unsubscribe footer. Kept separate from `layout` because a newsletter has no heading/CTA slot —
 * the body is the whole message — and every one must carry a working unsubscribe link.
 */
export function renderNewsletter(
  appName: string,
  args: { subject: string; body: string; unsubscribeUrl: string },
): EmailMessage {
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f7;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" style="max-width:600px;background:#fff;border-radius:12px;padding:32px">
          <tr><td>
            <p style="margin:0 0 24px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">${appName}</p>
            <div style="font-size:15px;line-height:1.6;color:#18181b">${args.body}</div>
            <hr style="margin:32px 0 16px;border:none;border-top:1px solid #e4e4e7" />
            <p style="margin:0;font-size:12px;color:#a1a1aa">You are receiving this because you subscribed to ${appName}. <a href="${args.unsubscribeUrl}" style="color:#71717a">Unsubscribe</a>.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`

  const text = `${args.body
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n\n—\nUnsubscribe: ${args.unsubscribeUrl}\n`

  return { to: '', subject: args.subject, html, text }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Substitutes `{{name}}` placeholders. Values are escaped for the HTML fields — the template body is
 * author-written HTML, but a name or address interpolated into it is data and must not be — and left
 * raw for the plain-text version.
 */
function interpolate(template: string, values: Record<string, string>, asHtml: boolean): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = values[key]
    if (value === undefined) return match
    return asHtml ? escapeHtml(value) : value
  })
}

/** A rough text rendering of a template's heading and body, with the link on its own line. */
function toText(heading: string, body: string, url: string): string {
  const stripped = body
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${heading}\n\n${stripped}\n\n${url}\n`
}

/**
 * Renders one message from a concrete content source and its variables — the shared core of both
 * `renderEmail` (which resolves the source from the database) and the admin preview endpoint (which
 * renders an unsaved draft).
 */
export function renderMessage(
  appName: string,
  source: EmailTemplateContent,
  variables: TemplateVariables,
): EmailMessage {
  const values = { appName, name: variables.name, to: variables.to, url: variables.url }
  const subject = interpolate(source.subject, values, false)
  const heading = interpolate(source.heading, values, true)
  const body = interpolate(source.body, values, true)
  const ctaLabel = source.ctaLabel ? interpolate(source.ctaLabel, values, true) : null

  return {
    to: variables.to,
    subject,
    html: layout(
      appName,
      heading,
      body,
      ctaLabel ? { url: variables.url, label: ctaLabel } : undefined,
    ),
    text: toText(
      interpolate(source.heading, values, false),
      interpolate(source.body, values, false),
      variables.url,
    ),
  }
}

/**
 * The stored override for a key, or null. Best-effort: a template lookup must never be the reason a
 * password-reset or invite email fails to send, so a database error falls through to the default.
 */
export async function loadTemplateOverride(
  env: Bindings,
  key: EmailTemplateKey,
): Promise<EmailTemplateContent | null> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.key, key))
      .limit(1)
    if (!row) return null
    return { subject: row.subject, heading: row.heading, body: row.body, ctaLabel: row.ctaLabel }
  } catch (error) {
    console.error('[email] template lookup failed, using default', key, error)
    return null
  }
}

/**
 * Builds a system email: the operator's override for `key` if one is stored, otherwise the built-in
 * default. This is what every send site calls, so a customised template reaches every path an email
 * of that kind is sent from.
 */
export async function renderEmail(
  env: Bindings,
  key: EmailTemplateKey,
  variables: TemplateVariables,
): Promise<EmailMessage> {
  const source = (await loadTemplateOverride(env, key)) ?? DEFAULT_EMAIL_TEMPLATES[key]
  return renderMessage(env.APP_NAME, source, variables)
}
