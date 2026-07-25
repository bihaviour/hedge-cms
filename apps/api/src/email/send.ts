import type { Bindings } from '../env'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * Sends through the Cloudflare Email Sending binding. The `from` domain must be onboarded:
 *   bunx wrangler email sending enable yourdomain.com
 *
 * In development the binding is not wired up, so we log instead of failing the request —
 * invite and reset links stay visible in `wrangler dev` output.
 */
export async function sendEmail(env: Bindings, message: EmailMessage): Promise<void> {
  if (env.ENVIRONMENT !== 'production' || !env.EMAIL) {
    console.log(`[email] to=${message.to} subject=${message.subject}\n${message.text}`)
    return
  }

  await env.EMAIL.send({
    to: message.to,
    from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME },
    subject: message.subject,
    html: message.html,
    text: message.text,
  })
}
