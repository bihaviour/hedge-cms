import {
  createSiteSchema,
  MCP_SCOPES,
  slugSchema,
  updateSiteConfigSchema,
  updateSiteSchema,
} from '@hedge/core'
import { z } from 'zod'
import { accessibleSites, siteRoleFor } from '../lib/auth'
import { ApiError } from '../lib/errors'
import {
  createSite,
  deleteSite,
  findSite,
  toSite,
  updateSite,
  updateSiteConfig,
} from '../lib/sites'
import { defineTool } from './registry'

/**
 * Site tools. These are the ones where the two authorisation levels visibly diverge:
 *
 * - renaming, re-domaining, creating and deleting a site is **instance** work, because a site is
 *   not its own owner and a site admin re-pointing a domain would be re-pointing the deployment
 * - a site's own metadata defaults, custom fields and email sender are **site** work, which is why
 *   `update_site_config` is separate and stops at site admin
 *
 * `get_site` and `list_sites` answer only for sites the caller can already reach — a user without
 * access gets a not-found rather than a forbidden, because which sites exist is itself information.
 */
export const siteTools = [
  defineTool({
    name: 'list_sites',
    title: 'List sites',
    description:
      'List the sites you can reach on this deployment. Every other tool acts on the *active* ' +
      'site, which the client selects with the `X-Hedge-Site` header — not on whichever site is ' +
      'named here.',
    args: z.object({}),
    access: { scope: MCP_SCOPES.sitesRead },
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const rows = await accessibleSites(ctx.env, ctx.actor)
      const data = rows.map(toSite)
      return {
        structured: { data },
        text: data
          .map(
            (site) => `- ${site.slug}${site.id === ctx.site.id ? ' (active)' : ''} — ${site.name}`,
          )
          .join('\n'),
      }
    },
  }),

  defineTool({
    name: 'get_site',
    title: 'Get site',
    description:
      'Fetch one site by slug, with its locales, timezone, SEO metadata defaults, custom field ' +
      'definitions and email sender overrides.',
    args: z.object({ slug: slugSchema }),
    access: { scope: MCP_SCOPES.sitesRead },
    annotations: { readOnlyHint: true },
    handler: async ({ slug }, ctx) => {
      const row = await findSite(ctx.env, slug)
      // Not a forbidden: a user without access has no business learning which sites exist.
      if (!(await siteRoleFor(ctx.env, ctx.actor, row.id))) throw ApiError.notFound('Site')
      const data = toSite(row)
      return { structured: data, text: JSON.stringify(data, null, 2) }
    },
  }),

  defineTool({
    name: 'create_site',
    title: 'Create site',
    description:
      'Create a new site on this deployment. A site is a whole tenant — its own collections, ' +
      'entries, media, members and keys. Unless `createDeliveryKey` is false, a `content:read` ' +
      'delivery key is issued with it and **its raw secret is returned once, in the result** — ' +
      'hand it to the person who asked and do not repeat it.',
    args: createSiteSchema,
    access: { scope: MCP_SCOPES.sitesWrite, instance: 'sites:create' },
    handler: async (input, ctx) => {
      const data = await createSite(ctx.env, input)
      const keyNote = data.deliveryKey
        ? ` Delivery key "${data.deliveryKey.name}" issued; its secret is in the result and cannot be shown again.`
        : ''
      return { structured: data, text: `Created site "${data.site.slug}".${keyNote}` }
    },
  }),

  defineTool({
    name: 'update_site',
    title: 'Update site',
    description:
      'Rename a site, change its domain, locales or timezone. Changing `domain` changes which ' +
      'hostname resolves to this tenant, so it affects the whole deployment — hence instance ' +
      'admin rather than site admin.',
    args: updateSiteSchema.extend({ slug: slugSchema.describe('Slug of the site to update') }),
    access: { scope: MCP_SCOPES.sitesWrite, instance: 'sites:update' },
    handler: async ({ slug, ...input }, ctx) => {
      const data = await updateSite(ctx.env, slug, input)
      return { structured: data, text: `Updated site "${data.slug}".` }
    },
  }),

  defineTool({
    name: 'update_site_config',
    title: 'Update site configuration',
    description:
      'Set the active site’s SEO metadata defaults, its per-entry custom field definitions, or ' +
      'its email sender overrides. This is the site’s own content configuration, so site admin ' +
      'is enough — unlike renaming or re-domaining it.',
    args: updateSiteConfigSchema,
    access: { scope: MCP_SCOPES.sitesWrite, permission: 'collections:update' },
    handler: async (input, ctx) => {
      const data = await updateSiteConfig(ctx.env, ctx.site.id, input)
      return { structured: data, text: `Updated configuration for "${data.slug}".` }
    },
  }),

  defineTool({
    name: 'delete_site',
    title: 'Delete site',
    description:
      'Delete a site and everything inside it — collections, entries, media rows, API keys and ' +
      'members. Irreversible, owner-only, and refused if it would leave the deployment with no ' +
      'sites at all.',
    args: z.object({ slug: slugSchema }),
    access: { scope: MCP_SCOPES.sitesWrite, instance: 'sites:delete' },
    annotations: { destructiveHint: true },
    handler: async ({ slug }, ctx) => {
      await deleteSite(ctx.env, slug)
      return { structured: { slug, deleted: true }, text: `Deleted site "${slug}".` }
    },
  }),
]
