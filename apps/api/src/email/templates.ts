import type { Bindings } from '../env'
import type { EmailMessage } from './send'

function layout(
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

export function inviteEmail(
  env: Bindings,
  args: { to: string; name: string; token: string },
): EmailMessage {
  const url = `${env.PUBLIC_URL}/accept-invite?token=${encodeURIComponent(args.token)}`
  return {
    to: args.to,
    subject: `You've been invited to ${env.APP_NAME}`,
    html: layout(
      env.APP_NAME,
      `Hi ${args.name}, you've been invited`,
      `<p style="margin:0">Set a password to activate your ${env.APP_NAME} account. This link expires in 7 days.</p>`,
      { url, label: 'Accept invite' },
    ),
    text: `Hi ${args.name},\n\nYou've been invited to ${env.APP_NAME}. Set your password here (expires in 7 days):\n${url}\n`,
  }
}

export function passwordResetEmail(
  env: Bindings,
  args: { to: string; name: string; token: string },
): EmailMessage {
  const url = `${env.PUBLIC_URL}/reset-password?token=${encodeURIComponent(args.token)}`
  return {
    to: args.to,
    subject: `Reset your ${env.APP_NAME} password`,
    html: layout(
      env.APP_NAME,
      'Reset your password',
      `<p style="margin:0">We received a request to reset the password for ${args.to}. This link expires in 1 hour. If you didn't ask for this, you can ignore this email.</p>`,
      { url, label: 'Reset password' },
    ),
    text: `Hi ${args.name},\n\nReset your ${env.APP_NAME} password here (expires in 1 hour):\n${url}\n\nIf you didn't request this, ignore this email.\n`,
  }
}
