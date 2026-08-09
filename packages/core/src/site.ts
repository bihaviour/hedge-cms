import { z } from 'zod'
import type { ApiKey } from './auth'
import { slugSchema } from './collection'
import { fieldsSchema } from './fields'
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  localeCodeSchema,
  localesSchema,
  timezoneSchema,
} from './i18n'
import { previewUrlSchema } from './preview'

/**
 * A site is the tenant boundary. One deployment holds many sites — a blog, a docs site, a
 * landing page — and every collection, entry, media object, API key and member belongs to
 * exactly one of them.
 */

/** Header the admin UI and delivery clients use to pick a site. Accepts a slug or an id. */
export const SITE_HEADER = 'x-hedge-site'

/**
 * Roles a user can hold *on one site*. `owner` is missing on purpose: it is an instance-level
 * role, and site-level `admin` already means full control of that site's content, keys and
 * members — it does not confer the right to add users or create sites.
 */
export const SITE_ROLES = ['admin', 'editor', 'viewer'] as const
export type SiteRole = (typeof SITE_ROLES)[number]

/** A user's role on one site, as shown in the admin's access editor. */
export const siteAccessSchema = z.object({
  siteId: z.string(),
  siteSlug: z.string(),
  siteName: z.string(),
  role: z.enum(SITE_ROLES),
  /**
   * What this user may approve on this site, or `null` to derive it from their site role. Kept as a
   * column on the grant rather than a table of its own: approval is a *site* power, and this row
   * already is somebody's site access — one that every request resolves anyway.
   */
  approvalLevel: z.number().int().min(0).max(2).nullable(),
  /** The level actually in force — the override above, or the site role's default. */
  effectiveApprovalLevel: z.number().int().min(0).max(2),
})

export type SiteAccess = z.infer<typeof siteAccessSchema>

/**
 * What the signed-in person may do on the site they are working in — the role they hold there, and
 * the approval level in force for them.
 *
 * Its own shape rather than a field on the session, because both answers are *per site* and the
 * session is not: the same user can be an admin on one site and a viewer on the next. The admin
 * reads it to gate the controls it renders, which is cosmetic — every route it gates still checks
 * for itself — but without it a viewer is offered buttons that can only answer 403.
 */
export const siteAuthoritySchema = z.object({
  role: z.enum(SITE_ROLES),
  approvalLevel: z.number().int().min(0).max(2),
})

export type SiteAuthority = z.infer<typeof siteAuthoritySchema>

export const setSiteRoleSchema = z.object({
  role: z.enum(SITE_ROLES),
  /** Omitted leaves any existing override alone; `null` clears it back to the role's default. */
  approvalLevel: z.number().int().min(0).max(2).nullable().optional(),
})

export type SetSiteRoleInput = z.infer<typeof setSiteRoleSchema>

/**
 * A single arbitrary metadata pair. The key is emitted verbatim into a `<meta>` tag or a
 * frontend's head, so it is constrained to what is safe there.
 */
export const metaEntrySchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][\w:.-]*$/, 'must start with a letter and use word characters, : . or -'),
  value: z.string().max(2000),
})

export type MetaEntry = z.infer<typeof metaEntrySchema>

/**
 * A site's default metadata — the SEO and social defaults every entry inherits unless it sets its
 * own. `titleTemplate` is applied to an entry's title with `%s` standing in for it, e.g. a template
 * of `"%s · Docs"` turns a page titled `"Routing"` into `"Routing · Docs"`.
 */
export const siteMetadataSchema = z.object({
  metaTitle: z.string().max(200).optional(),
  titleTemplate: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  keywords: z.array(z.string().max(80)).max(50).default([]),
  ogImage: z.string().max(2000).optional(),
  twitterHandle: z.string().max(80).optional(),
  /** Free-form pairs — an escape hatch for whatever a frontend wants that has no dedicated field. */
  custom: z.array(metaEntrySchema).max(50).default([]),
})

export type SiteMetadata = z.infer<typeof siteMetadataSchema>

/**
 * A sender identity a site owns: an address it sends from, a display name, and a reply-to. Every
 * field is nullable and null means inherit — the deployment's stored email config first, then
 * `EMAIL_FROM` / `EMAIL_FROM_NAME`.
 *
 * A site carries **two** of these (#134): one for the transactional email its members receive, one
 * for its newsletters — so member invites and a newsletter can come from different addresses. They
 * share this shape, hence one schema.
 *
 * Operator email (a CMS user's invite or password reset) reads neither. That belongs to the
 * deployment, not to a site, and a site admin must not be able to change what it says it is from.
 *
 * A `fromEmail` here is not a spoofing vector: Cloudflare Email Sending only accepts a domain
 * onboarded on the account, so an address on a domain the deployment does not own fails at the
 * provider rather than leaving it — which is why these fields can be self-served.
 */
export const siteEmailSenderSchema = z.object({
  fromEmail: z.email().max(320).nullable(),
  fromName: z.string().max(120).nullable(),
  replyTo: z.email().max(320).nullable(),
})

export type SiteEmailSender = z.infer<typeof siteEmailSenderSchema>

/** The member-transactional sender, named for clarity where both appear. */
export type MemberEmailSender = SiteEmailSender
/** The newsletter sender — same shape, distinct slot on the site. */
export type NewsletterEmailSender = SiteEmailSender

/** Inherit everything — what a sender a site has never set reads as. Both senders start here. */
export const INHERITED_EMAIL_SENDER: SiteEmailSender = {
  fromEmail: null,
  fromName: null,
  replyTo: null,
}

export const siteSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  /** Public hostname of the website this site feeds, used to resolve the tenant from `Host`. */
  domain: z.string().max(253).nullable(),
  /** When false, members can only be added from the admin. */
  allowMemberSignup: z.boolean(),
  /** Content locales this site publishes — entries live once per locale (see `entry.ts`). */
  locales: localesSchema,
  /** Which enabled locale the delivery API serves when a request names none. */
  defaultLocale: localeCodeSchema,
  /** IANA timezone the admin renders this site's timestamps in. */
  timezone: timezoneSchema,
  /** Per-site metadata defaults — see `siteMetadataSchema`. Unique to this site. */
  metadata: siteMetadataSchema,
  /**
   * Reusable custom field definitions scoped to this site. Every entry on the site carries values
   * for these under its `metadata.custom`, on top of whatever fields its own collection defines.
   */
  customFields: fieldsSchema,
  /** This site's sender for the transactional email its members receive — see `siteEmailSenderSchema`. */
  emailSender: siteEmailSenderSchema,
  /** This site's default sender for its newsletters, overridable per campaign (#134). */
  newsletterSender: siteEmailSenderSchema,
  /**
   * Base URL of the website's own preview endpoint — see `preview.ts`. Null means this site has no
   * preview configured, and the admin hides the Preview action rather than rendering one that 404s.
   */
  previewUrl: z.string().nullable(),
  /**
   * Whether the admin may show a preview inside an embedded pane as well as in a new tab.
   *
   * Off by default and opt-in per site, because it only works when the website lets the CMS origin
   * frame it — `X-Frame-Options` or a `Content-Security-Policy` without `frame-ancestors` renders a
   * blank pane, and cross-origin framing gives the parent no reliable way to detect that. Opening
   * in a tab always works, so that stays the default.
   */
  previewEmbed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Site = z.infer<typeof siteSchema>

/** Hostnames only — no scheme, no path, no port. */
const domainSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'must be a hostname')

export const createSiteSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    domain: domainSchema.nullable().optional(),
    allowMemberSignup: z.boolean().default(true),
    locales: localesSchema.default([DEFAULT_LOCALE]),
    defaultLocale: localeCodeSchema.default(DEFAULT_LOCALE),
    timezone: timezoneSchema.default(DEFAULT_TIMEZONE),
    /**
     * Issue a `content:read` delivery key alongside the site — the credential a public website
     * needs and that the delivery API has no anonymous fallback for. On by default so the
     * interactive create-site flow gets a working site; a scripted creation that manages keys
     * itself can pass `false`. The plaintext is returned once, in the create response.
     */
    createDeliveryKey: z.boolean().default(true),
  })
  .refine((value) => value.locales.includes(value.defaultLocale), {
    message: 'the default locale must be one of the enabled locales',
    path: ['defaultLocale'],
  })

export type CreateSiteInput = z.infer<typeof createSiteSchema>

/**
 * The result of creating a site. `deliveryKey` carries the raw `key` secret and is the only time it
 * is ever returned — treat this response like the API-key create response in logging and anything
 * that records request bodies. Null when `createDeliveryKey` was false.
 *
 * A type alias rather than an interface because `create_site` returns it as MCP
 * `structuredContent`, which is typed `Record<string, unknown>` to keep a bare array out of it
 * (#114) — and an interface has no implicit index signature, so it would not assign.
 */
export type CreateSiteResult = {
  site: Site
  deliveryKey: (ApiKey & { key: string }) | null
}

/** The predictable name a site's auto-issued delivery key is given, so it reads as infrastructure. */
export const DELIVERY_KEY_NAME = 'delivery'

/**
 * Locale and timezone are all optional here, like everything else — but `defaultLocale` and
 * `locales` can drift out of agreement across two partial updates, so the route re-checks their
 * consistency against the site's current state (a schema `.refine` only sees the fields present in
 * one request). See `routes/sites.ts`.
 */
export const updateSiteSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  domain: domainSchema.nullable().optional(),
  allowMemberSignup: z.boolean().optional(),
  locales: localesSchema.optional(),
  defaultLocale: localeCodeSchema.optional(),
  timezone: timezoneSchema.optional(),
})

export type UpdateSiteInput = z.infer<typeof updateSiteSchema>

/**
 * A site's metadata defaults, custom fields and sender, edited from Site Settings. Kept apart from
 * `updateSiteSchema` because it is authorised at the *site* level — a per-site admin owns their
 * site's content configuration — where name, domain and member signup are instance-admin concerns.
 *
 * Each sender is all-or-nothing: sending one replaces all three of its fields, so clearing one
 * override is a matter of sending it as null rather than omitting it. Omitting a sender entirely
 * leaves it untouched, which is what lets the two sender forms in Site settings save independently.
 */
export const updateSiteConfigSchema = z.object({
  metadata: siteMetadataSchema.optional(),
  customFields: fieldsSchema.optional(),
  emailSender: siteEmailSenderSchema.optional(),
  newsletterSender: siteEmailSenderSchema.optional(),
  /**
   * Where preview points, and whether it may be framed. Site-level rather than instance-level for
   * the same reason the rest of this schema is: which URL renders this site's drafts is the site
   * admin's business, where the site's *domain* is the deployment's.
   */
  previewUrl: previewUrlSchema.nullable().optional(),
  previewEmbed: z.boolean().optional(),
})

export type UpdateSiteConfigInput = z.infer<typeof updateSiteConfigSchema>
