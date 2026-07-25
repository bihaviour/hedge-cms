import { z } from 'zod'
import { slugSchema } from './collection'

/**
 * A site is the tenant boundary. One deployment holds many sites — a blog, a docs site, a
 * landing page — and every collection, entry, media object, API key and member belongs to
 * exactly one of them.
 */

/** Header the admin UI and delivery clients use to pick a site. Accepts a slug or an id. */
export const SITE_HEADER = 'x-hedge-site'

export const siteSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  /** Public hostname of the website this site feeds, used to resolve the tenant from `Host`. */
  domain: z.string().max(253).nullable(),
  /** When false, members can only be added from the admin. */
  allowMemberSignup: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Site = z.infer<typeof siteSchema>

/** Hostnames only — no scheme, no path, no port. */
const domainSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'must be a hostname')

export const createSiteSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  domain: domainSchema.nullable().optional(),
  allowMemberSignup: z.boolean().default(true),
})

export type CreateSiteInput = z.infer<typeof createSiteSchema>

export const updateSiteSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  domain: domainSchema.nullable().optional(),
  allowMemberSignup: z.boolean().optional(),
})

export type UpdateSiteInput = z.infer<typeof updateSiteSchema>
