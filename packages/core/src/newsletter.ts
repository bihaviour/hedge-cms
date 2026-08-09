import { z } from 'zod'
import { siteEmailSenderSchema } from './site'

/* ------------------------------------------------------------------ *
 * Subscribers — a per-site list of email addresses, lighter than a Member (no account, no
 * password): anyone who wants the newsletter, whether or not they can sign in.
 * ------------------------------------------------------------------ */

export const SUBSCRIBER_STATUSES = ['subscribed', 'unsubscribed'] as const

export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number]

export const subscriberSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  status: z.enum(SUBSCRIBER_STATUSES),
  /** Where the address came from — "import", "signup form", a page path, etc. */
  source: z.string().nullable(),
  createdAt: z.string(),
  unsubscribedAt: z.string().nullable(),
})

export type Subscriber = z.infer<typeof subscriberSchema>

export const createSubscriberSchema = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional(),
})

export type CreateSubscriberInput = z.infer<typeof createSubscriberSchema>

export const updateSubscriberSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  status: z.enum(SUBSCRIBER_STATUSES).optional(),
})

export type UpdateSubscriberInput = z.infer<typeof updateSubscriberSchema>

/** What a website's signup form posts to the public subscribe endpoint. */
export const publicSubscribeSchema = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional(),
  /** Optional free-form origin the site can pass, e.g. the page the form sat on. */
  source: z.string().max(200).optional(),
})

export type PublicSubscribeInput = z.infer<typeof publicSubscribeSchema>

/* ------------------------------------------------------------------ *
 * Newsletters — the campaigns themselves.
 * ------------------------------------------------------------------ */

export const NEWSLETTER_STATUSES = ['draft', 'sending', 'sent'] as const

export type NewsletterStatus = (typeof NEWSLETTER_STATUSES)[number]

/** Who a newsletter reaches: the subscriber list, the site's members, or both (deduped by email). */
export const NEWSLETTER_AUDIENCES = ['subscribers', 'members', 'both'] as const

export type NewsletterAudience = (typeof NEWSLETTER_AUDIENCES)[number]

export const newsletterSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(NEWSLETTER_STATUSES),
  audience: z.enum(NEWSLETTER_AUDIENCES),
  /**
   * This campaign's own sender override (#134). Null fields inherit the site's newsletter sender —
   * so an author can send one newsletter as themselves without disturbing the site default. This is
   * the *stored* override, not the resolved sender, so the compose form shows exactly what was set.
   */
  sender: siteEmailSenderSchema,
  sentAt: z.string().nullable(),
  /** How many recipients it went to, set once sent. */
  recipientCount: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Newsletter = z.infer<typeof newsletterSchema>

export const createNewsletterSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
  audience: z.enum(NEWSLETTER_AUDIENCES).default('both'),
  /** Optional per-campaign sender override; omit to send from the site's newsletter sender (#134). */
  sender: siteEmailSenderSchema.optional(),
})

export type CreateNewsletterInput = z.infer<typeof createNewsletterSchema>

export const updateNewsletterSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(50_000).optional(),
  audience: z.enum(NEWSLETTER_AUDIENCES).optional(),
  sender: siteEmailSenderSchema.optional(),
})

export type UpdateNewsletterInput = z.infer<typeof updateNewsletterSchema>

export const testSendSchema = z.object({
  email: z.string().email(),
})

export type TestSendInput = z.infer<typeof testSendSchema>

/* ------------------------------------------------------------------ *
 * Templates — a per-site library of reusable newsletter blueprints. A new campaign can be started
 * from one, and a draft can be saved back as one, so recurring issues don't start from a blank page.
 * ------------------------------------------------------------------ */

export const newsletterTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type NewsletterTemplate = z.infer<typeof newsletterTemplateSchema>

export const createNewsletterTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
})

export type CreateNewsletterTemplateInput = z.infer<typeof createNewsletterTemplateSchema>

export const updateNewsletterTemplateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(50_000).optional(),
})

export type UpdateNewsletterTemplateInput = z.infer<typeof updateNewsletterTemplateSchema>

/** What a preview request renders — a subject line and the wrapped HTML, sample data filled in. */
export const newsletterPreviewInputSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
  /** The draft's sender override, so the preview's brand matches what will actually send (#134). */
  sender: siteEmailSenderSchema.optional(),
})

export type NewsletterPreviewInput = z.infer<typeof newsletterPreviewInputSchema>

export const newsletterPreviewSchema = z.object({
  subject: z.string(),
  html: z.string(),
})

export type NewsletterPreview = z.infer<typeof newsletterPreviewSchema>

/** The result of a send: how many recipients it reached, and how many the provider rejected. */
export interface SendResult {
  recipientCount: number
  failed: number
}
