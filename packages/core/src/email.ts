import { z } from 'zod'

/**
 * The system emails Hedge sends. Each has a built-in default (below) an operator can override from
 * the admin, and every one is rendered through the same branded layout. The keys are stable — they
 * are the join between a stored override, the send site that emits the email, and a log row.
 */
export const EMAIL_TEMPLATE_KEYS = [
  'invite',
  'password_reset',
  'member_invite',
  'member_reset',
  'member_verify',
] as const

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number]

/**
 * Every template renders from the same four variables, referenced as `{{name}}` in any field. They
 * are listed per key so the editor can show which ones a given email has to work with, even though
 * the set happens to be uniform today.
 */
export const EMAIL_TEMPLATE_VARIABLES = ['appName', 'name', 'to', 'url'] as const

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
  ctaLabel: string
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
