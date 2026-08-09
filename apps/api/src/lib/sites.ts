import {
  type CreateSiteInput,
  type CreateSiteResult,
  DELIVERY_KEY_NAME,
  fieldsSchema,
  type Site,
  siteMetadataSchema,
  type UpdateSiteConfigInput,
  type UpdateSiteInput,
} from '@hedge/core'
import { and, count, eq, ne } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type SiteRow, sites } from '../db/schema'
import type { Bindings } from '../env'
import { createApiKey } from './api-keys'
import { ApiError } from './errors'
import { newId } from './id'

/**
 * Site CRUD, factored out of the HTTP route so the REST API and the MCP endpoint share it.
 *
 * Nothing here checks authorisation — a site is reachable at two different levels (instance admin
 * to rename or re-domain one, site admin to change its content configuration) and the callers make
 * that distinction. Read `routes/sites.ts` and `mcp/sites.ts` together before changing a signature.
 */

export function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    domain: row.domain,
    allowMemberSignup: row.allowMemberSignup,
    locales: row.locales,
    defaultLocale: row.defaultLocale,
    timezone: row.timezone,
    // Null on rows predating these columns and on freshly created sites — parse into empty defaults.
    metadata: siteMetadataSchema.parse(row.metadata ?? {}),
    customFields: fieldsSchema.parse(row.customFields ?? []),
    // Nulls are meaningful here rather than missing: each one means "inherit the deployment's".
    emailSender: {
      fromEmail: row.emailFrom,
      fromName: row.emailFromName,
      replyTo: row.emailReplyTo,
    },
    newsletterSender: {
      fromEmail: row.newsletterFrom,
      fromName: row.newsletterFromName,
      replyTo: row.newsletterReplyTo,
    },
    previewUrl: row.previewUrl,
    previewEmbed: row.previewEmbed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function findSite(env: Bindings, slug: string): Promise<SiteRow> {
  const [row] = await getDb(env).select().from(sites).where(eq(sites.slug, slug)).limit(1)
  if (!row) throw ApiError.notFound('Site')
  return row
}

/** Two sites answering to the same hostname would make `Host` resolution ambiguous. */
async function assertDomainFree(env: Bindings, domain: string, exceptSiteId?: string) {
  const [clash] = await getDb(env)
    .select({ slug: sites.slug })
    .from(sites)
    .where(
      exceptSiteId
        ? and(eq(sites.domain, domain), ne(sites.id, exceptSiteId))
        : eq(sites.domain, domain),
    )
    .limit(1)

  if (clash) throw ApiError.conflict(`"${domain}" is already pointed at the "${clash.slug}" site`)
}

export async function createSite(env: Bindings, input: CreateSiteInput): Promise<CreateSiteResult> {
  const db = getDb(env)

  const [existing] = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, input.slug))
  if (existing) throw ApiError.conflict(`A site with slug "${input.slug}" already exists`)
  if (input.domain) await assertDomainFree(env, input.domain)

  const [row] = await db
    .insert(sites)
    .values({
      id: newId('sit'),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      domain: input.domain ?? null,
      allowMemberSignup: input.allowMemberSignup,
      locales: input.locales,
      defaultLocale: input.defaultLocale,
      timezone: input.timezone,
    })
    .returning()

  const site = toSite(row!)

  // A site with no key is a site no website can read — the delivery API has no anonymous fallback.
  // Issue the `content:read` delivery credential here so the create-site flow ends with a working
  // site, scoped to reading published content only: auto-issuing anything write-scoped would hand
  // every new site a key that reaches the authoring routes, the exact split we maintain elsewhere.
  const deliveryKey = input.createDeliveryKey
    ? await createApiKey(env, site.id, { name: DELIVERY_KEY_NAME, scopes: ['content:read'] }, null)
    : null

  return { site, deliveryKey }
}

export async function updateSite(
  env: Bindings,
  slug: string,
  input: UpdateSiteInput,
): Promise<Site> {
  const existing = await findSite(env, slug)
  if (input.domain) await assertDomainFree(env, input.domain, existing.id)

  // A schema `.refine` only sees one request's fields, so it cannot catch a `defaultLocale` that no
  // longer sits inside `locales` after a partial update — check the *merged* state here instead.
  const locales = input.locales ?? existing.locales
  const defaultLocale = input.defaultLocale ?? existing.defaultLocale
  if (!locales.includes(defaultLocale)) {
    throw ApiError.badRequest('The default locale must be one of the enabled locales', {
      defaultLocale: ['the default locale must be one of the enabled locales'],
    })
  }

  const [row] = await getDb(env)
    .update(sites)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      ...(input.allowMemberSignup !== undefined
        ? { allowMemberSignup: input.allowMemberSignup }
        : {}),
      ...(input.locales !== undefined ? { locales: input.locales } : {}),
      ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sites.id, existing.id))
    .returning()

  return toSite(row!)
}

/** A site's metadata defaults, custom fields and sender overrides. A site-admin power. */
export async function updateSiteConfig(
  env: Bindings,
  siteId: string,
  input: UpdateSiteConfigInput,
): Promise<Site> {
  const [row] = await getDb(env)
    .update(sites)
    .set({
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      // All three move together, so a cleared override is a null the caller sent rather than a
      // field it happened to leave out.
      ...(input.emailSender !== undefined
        ? {
            emailFrom: input.emailSender.fromEmail,
            emailFromName: input.emailSender.fromName,
            emailReplyTo: input.emailSender.replyTo,
          }
        : {}),
      // The newsletter sender saves independently of the member one — omitting either leaves it be.
      ...(input.newsletterSender !== undefined
        ? {
            newsletterFrom: input.newsletterSender.fromEmail,
            newsletterFromName: input.newsletterSender.fromName,
            newsletterReplyTo: input.newsletterSender.replyTo,
          }
        : {}),
      ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
      ...(input.previewEmbed !== undefined ? { previewEmbed: input.previewEmbed } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sites.id, siteId))
    .returning()

  if (!row) throw ApiError.notFound('Site')
  return toSite(row)
}

/** Deleting a site takes its collections, entries, media rows, keys and members with it. */
export async function deleteSite(env: Bindings, slug: string): Promise<void> {
  const existing = await findSite(env, slug)
  const db = getDb(env)

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(sites)
  if (total <= 1) throw ApiError.badRequest('An instance must keep at least one site')

  await db.delete(sites).where(eq(sites.id, existing.id))
}
