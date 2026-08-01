import { z } from 'zod'

/**
 * The system emails Hedge sends. Each has a built-in default (below) an operator can override from
 * the admin, and every one is rendered through the same branded layout. The keys are stable — they
 * are the join between a stored override, the send site that emits the email, and a log row.
 */
export const EMAIL_TEMPLATE_KEYS = [
  'invite',
  'password_reset',
  'login_code',
  'member_invite',
  'member_reset',
  'member_verify',
  'version_submitted',
  'version_approved',
  'version_changes_requested',
] as const

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number]

/** The four variables every template renders from, referenced as `{{name}}` in any field. */
export const EMAIL_TEMPLATE_VARIABLES = ['appName', 'name', 'to', 'url'] as const

/**
 * Variables a specific template renders from on top of the four above. The review emails are the
 * first templates whose set is not uniform — a notification that says nothing about *what* is
 * waiting is not worth sending — so the editor asks for the list per key rather than assuming it.
 */
export const EMAIL_TEMPLATE_EXTRA_VARIABLES: Partial<Record<EmailTemplateKey, readonly string[]>> =
  {
    version_submitted: ['title', 'comment'],
    version_approved: ['title', 'comment'],
    version_changes_requested: ['title', 'comment'],
    // `code` is the whole point of the message and `device` is what lets someone who did not sign in
    // recognise that. An override that drops `{{code}}` sends an unusable email, so the editor has
    // to show it.
    login_code: ['code', 'device'],
  }

/** Every variable one template has to work with, in the order the editor should list them. */
export function emailTemplateVariables(key: EmailTemplateKey): string[] {
  return [...EMAIL_TEMPLATE_VARIABLES, ...(EMAIL_TEMPLATE_EXTRA_VARIABLES[key] ?? [])]
}

/** The editable body of a template — the shape stored as an override and rendered from. */
export interface EmailTemplateContent {
  subject: string
  heading: string
  body: string
  /** The call-to-action button label, or null for a template with no button. */
  ctaLabel: string | null
}

interface EmailTemplateDefinition extends EmailTemplateContent {
  label: string
  description: string
}

/**
 * The built-in copy. Used when no override is stored, shown as the starting point in the editor,
 * and restored by "reset to default". Kept in `@hedge/core` so the admin renders the same defaults
 * the Worker sends.
 */
export const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateKey, EmailTemplateDefinition> = {
  invite: {
    label: 'Operator invite',
    description: 'Sent to a CMS user when they are invited, with the link to set their password.',
    subject: "You've been invited to {{appName}}",
    heading: "Hi {{name}}, you've been invited",
    body: '<p style="margin:0">Set a password to activate your {{appName}} account. This link expires in 7 days.</p>',
    ctaLabel: 'Accept invite',
  },
  password_reset: {
    label: 'Operator password reset',
    description: 'Sent to a CMS user who asked to reset their password.',
    subject: 'Reset your {{appName}} password',
    heading: 'Reset your password',
    body: '<p style="margin:0">We received a request to reset the password for {{to}}. This link expires in 1 hour. If you didn\'t ask for this, you can ignore this email.</p>',
    ctaLabel: 'Reset password',
  },
  // The one template whose payload is the code itself rather than a link, so it carries no CTA:
  // a button here would invite someone to click through from the email on a *different* device to
  // the one waiting for the code, which is the opposite of what the check is for.
  login_code: {
    label: 'Sign-in verification code',
    description:
      'Sent when someone signs in from a browser this account has not been seen on before.',
    subject: 'Your {{appName}} sign-in code is {{code}}',
    heading: 'Your sign-in code',
    body: '<p style="margin:0">Someone signed in to {{appName}} as {{to}} from a device we don\'t recognise. Enter this code to finish:</p><p style="margin:20px 0;font-size:30px;font-weight:600;letter-spacing:.18em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">{{code}}</p><p style="margin:0">It expires in 10 minutes. <strong>If this wasn\'t you, someone knows your password</strong> — change it now, and it was attempted from {{device}}.</p>',
    ctaLabel: null,
  },
  member_invite: {
    label: 'Member invite',
    description: 'Sent to a website member added by an admin, with the link to choose a password.',
    subject: 'Set up your {{appName}} account',
    heading: 'Hi {{name}}, your account is ready',
    body: '<p style="margin:0">Choose a password to finish setting up the account for {{to}}. This link expires in 24 hours — ask for a new one if it lapses.</p>',
    ctaLabel: 'Set your password',
  },
  member_reset: {
    label: 'Member password reset',
    description: 'Sent to a website member who asked to reset their password.',
    subject: 'Reset your password',
    heading: 'Reset your password',
    body: '<p style="margin:0">We received a request to reset the password for {{to}}. This link expires in 24 hours. If you didn\'t ask for this, you can ignore this email.</p>',
    ctaLabel: 'Reset password',
  },
  member_verify: {
    label: 'Member email verification',
    description: 'Sent to a website member to confirm their email address.',
    subject: 'Confirm your email address',
    heading: 'Confirm your email address',
    body: '<p style="margin:0">Confirm {{to}} so we know we can reach you. This link expires in 24 hours.</p>',
    ctaLabel: 'Confirm email',
  },
  // The three review notifications. These are *operator* email — staff mail about the CMS itself —
  // so they go out as the deployment's sender, never a site's. See `sendEmail`'s `site` option.
  version_submitted: {
    label: 'Version submitted for review',
    description: 'Sent to the approvers on a site when an author submits a version for review.',
    subject: 'A version is waiting for your review',
    heading: 'Hi {{name}}, a version needs a look',
    body: '<p style="margin:0">“{{title}}” has been submitted for review on {{appName}}. Open it to compare it against what is live and approve or send it back.</p>',
    ctaLabel: 'Review the version',
  },
  version_approved: {
    label: 'Version approved',
    description: "Sent to a version's author when an approver signs off on it.",
    subject: 'Your version was approved',
    heading: 'Hi {{name}}, your version was approved',
    body: '<p style="margin:0">“{{title}}” has been approved on {{appName}}.</p><p style="margin:12px 0 0">{{comment}}</p>',
    ctaLabel: 'Open the version',
  },
  version_changes_requested: {
    label: 'Version sent back',
    description: "Sent to a version's author when an approver asks for changes.",
    subject: 'Changes were requested on your version',
    heading: 'Hi {{name}}, your version needs changes',
    body: '<p style="margin:0">“{{title}}” was sent back on {{appName}}.</p><p style="margin:12px 0 0">{{comment}}</p>',
    ctaLabel: 'Open the version',
  },
}

/** One template as the admin sees it: the effective content, plus whether it is an override. */
export const emailTemplateSchema = z.object({
  key: z.enum(EMAIL_TEMPLATE_KEYS),
  label: z.string(),
  description: z.string(),
  variables: z.array(z.string()),
  subject: z.string(),
  heading: z.string(),
  body: z.string(),
  ctaLabel: z.string().nullable(),
  /** True when a stored override is in effect rather than the built-in default. */
  customized: z.boolean(),
  updatedAt: z.string().nullable(),
})

export type EmailTemplate = z.infer<typeof emailTemplateSchema>

export const updateEmailTemplateSchema = z.object({
  subject: z.string().min(1).max(200),
  heading: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  ctaLabel: z.string().max(60).nullable().optional(),
})

export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>

export const emailTemplatePreviewSchema = z.object({
  subject: z.string(),
  html: z.string(),
})

export type EmailTemplatePreview = z.infer<typeof emailTemplatePreviewSchema>

/* ------------------------------------------------------------------ *
 * Log
 * ------------------------------------------------------------------ */

/**
 * `sent` — handed to the provider. `failed` — the provider rejected it. `skipped` — not sent on
 * purpose: development (no binding) or sending switched off in the email config.
 */
export const EMAIL_STATUSES = ['sent', 'failed', 'skipped'] as const

export type EmailStatus = (typeof EMAIL_STATUSES)[number]

export const emailLogSchema = z.object({
  id: z.string(),
  to: z.string(),
  subject: z.string(),
  /** The template that produced it, or null for a one-off. */
  templateKey: z.enum(EMAIL_TEMPLATE_KEYS).nullable(),
  status: z.enum(EMAIL_STATUSES),
  error: z.string().nullable(),
  createdAt: z.string(),
})

export type EmailLog = z.infer<typeof emailLogSchema>

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * Sender configuration. The overrides sit on top of the deployment's `EMAIL_FROM` / `EMAIL_FROM_NAME`
 * environment variables — a null field means "use the deployment default", which is surfaced back on
 * the read so the admin can see what will actually be used.
 */
export const emailConfigSchema = z.object({
  fromEmail: z.string().nullable(),
  fromName: z.string().nullable(),
  replyTo: z.string().nullable(),
  /** When false, Hedge composes and logs emails but never hands them to the provider. */
  enabled: z.boolean(),
  /** Read-only: the deployment defaults an unset override falls back to. */
  defaultFromEmail: z.string(),
  defaultFromName: z.string(),
  updatedAt: z.string().nullable(),
})

export type EmailConfig = z.infer<typeof emailConfigSchema>

export const updateEmailConfigSchema = z.object({
  fromEmail: z.string().email().nullable().optional(),
  fromName: z.string().max(120).nullable().optional(),
  replyTo: z.string().email().nullable().optional(),
  enabled: z.boolean().optional(),
})

export type UpdateEmailConfigInput = z.infer<typeof updateEmailConfigSchema>
