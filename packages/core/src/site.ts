import { z } from 'zod'
import { slugSchema } from './collection'
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  localeCodeSchema,
  localesSchema,
  timezoneSchema,
} from './i18n'

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
})

export type SiteAccess = z.infer<typeof siteAccessSchema>

export const setSiteRoleSchema = z.object({ role: z.enum(SITE_ROLES) })

export type SetSiteRoleInput = z.infer<typeof setSiteRoleSchema>

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
  })
  .refine((value) => value.locales.includes(value.defaultLocale), {
    message: 'the default locale must be one of the enabled locales',
    path: ['defaultLocale'],
  })

export type CreateSiteInput = z.infer<typeof createSiteSchema>

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
