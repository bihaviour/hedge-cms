import {
  createSiteSchema,
  fieldsSchema,
  roleAtLeast,
  type Site,
  siteMetadataSchema,
  updateSiteConfigSchema,
  updateSiteSchema,
} from '@hedge/core'
import { and, count, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { type SiteRow, sites } from '../db/schema'
import type { AppEnv, Bindings } from '../env'
import { accessibleSites, requireActor, requireRole, siteRoleFor } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function findSite(env: Bindings, slug: string): Promise<SiteRow> {
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

/**
 * The sites this caller can reach — every site for owners and admins, granted ones for everyone
 * else, and just its own for an API key. This is what fills the admin's site switcher, so a
 * user is never offered a site they would be refused on.
 */
app.get('/', async (c) => {
  const rows = await accessibleSites(c.env, requireActor(c))
  return c.json({ data: rows.map(toSite) })
})

app.post('/', requireRole('admin'), async (c) => {
  const input = await validate(c, createSiteSchema)
  const db = getDb(c.env)

  const [existing] = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, input.slug))
  if (existing) throw ApiError.conflict(`A site with slug "${input.slug}" already exists`)
  if (input.domain) await assertDomainFree(c.env, input.domain)

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

  return c.json({ data: toSite(row!) }, 201)
})

app.get('/:slug', async (c) => {
  const row = await findSite(c.env, c.req.param('slug'))
  // Not a 403: a user without access has no business learning which sites exist.
  if (!(await siteRoleFor(c.env, requireActor(c), row.id))) throw ApiError.notFound('Site')
  return c.json({ data: toSite(row) })
})

app.patch('/:slug', requireRole('admin'), async (c) => {
  const input = await validate(c, updateSiteSchema)
  const existing = await findSite(c.env, c.req.param('slug'))
  if (input.domain) await assertDomainFree(c.env, input.domain, existing.id)

  // A schema `.refine` only sees one request's fields, so it cannot catch a `defaultLocale` that no
  // longer sits inside `locales` after a partial update — check the *merged* state here instead.
  const locales = input.locales ?? existing.locales
  const defaultLocale = input.defaultLocale ?? existing.defaultLocale
  if (!locales.includes(defaultLocale)) {
    throw ApiError.badRequest('The default locale must be one of the enabled locales', {
      defaultLocale: ['the default locale must be one of the enabled locales'],
    })
  }

  const [row] = await getDb(c.env)
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

  return c.json({ data: toSite(row!) })
})

/**
 * A site's metadata defaults and custom fields. Authorised at the site level — a per-site admin
 * owns their own site's content configuration — rather than requiring an instance admin the way
 * renaming or re-domaining a site does. Role is checked against the site named in the path, exactly
 * as `GET /:slug` does, so the active-site header cannot widen a caller's reach here.
 */
app.patch('/:slug/config', async (c) => {
  const actor = requireActor(c)
  const existing = await findSite(c.env, c.req.param('slug'))

  const role = await siteRoleFor(c.env, actor, existing.id)
  if (!role || !roleAtLeast(role, 'admin')) {
    throw ApiError.forbidden('Site admin access is required to change site settings')
  }

  const input = await validate(c, updateSiteConfigSchema)
  const [row] = await getDb(c.env)
    .update(sites)
    .set({
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sites.id, existing.id))
    .returning()

  return c.json({ data: toSite(row!) })
})

/** Deleting a site takes its collections, entries, media rows, keys and members with it. */
app.delete('/:slug', requireRole('owner'), async (c) => {
  const existing = await findSite(c.env, c.req.param('slug'))
  const db = getDb(c.env)

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(sites)
  if (total <= 1) throw ApiError.badRequest('An instance must keep at least one site')

  await db.delete(sites).where(eq(sites.id, existing.id))
  return c.body(null, 204)
})

export default app
