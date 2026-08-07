import type { EmailTemplateKey } from '@hedge/core'

/**
 * The subject a send is *logged* under, which is not always the one it was sent with.
 *
 * A `login_code` subject carries the code itself, and that is deliberate — it is what lets someone
 * read it off a notification without opening the mail. The log is a different matter: `email_log` is
 * served by `GET /api/v1/email/log` to anyone holding `email:manage`, so storing it verbatim leaves
 * a live second factor in a table a whole tier of operators can read, including for accounts more
 * privileged than their own. That is the precise escalation step-up verification exists to stop, and
 * `login_challenges.codeHash` is already an HMAC so the code is unrecoverable from that table — the
 * log must not be the hole that puts it back.
 *
 * Digit runs rather than a fixed template string, because operators can override a template's
 * subject (`PUT /api/v1/email/templates/:key`) and the override still has to be redacted. Masking a
 * deployment name that happens to contain digits is the acceptable side of that trade: an
 * over-redacted log entry costs nothing, an under-redacted one is a live credential.
 *
 * It lives in its own module rather than beside `sendEmail` so a test can reach it without tripping
 * over the `mock.module('../email/send', …)` that the step-up tests install process-wide.
 */
export function loggedSubject(subject: string, templateKey: EmailTemplateKey | undefined): string {
  return templateKey === 'login_code' ? subject.replace(/\d{3,}/g, '••••••') : subject
}
