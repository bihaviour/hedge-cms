import { inviteUserSchema, MCP_SCOPES, ROLES, SITE_ROLES, slugSchema } from '@hedge/core'
import { z } from 'zod'
import { findSite } from '../lib/sites'
import {
  deleteUser,
  inviteUser,
  listUserSites,
  listUsers,
  removeUserSiteRole,
  setUserSiteRole,
  updateUser,
} from '../lib/users'
import { defineTool } from './registry'

/**
 * User management. Every tool here is gated at the **instance** level (`users.role`), not the site
 * level, because who may sign in to the deployment is not one tenant's business — a site admin
 * inviting users would be a site admin minting deployment access.
 *
 * The guards that hold whoever is calling live in `lib/users.ts` and apply here unchanged: nobody
 * changes their own role, nobody deletes their own account, and the owner account cannot be
 * deleted at all. Those are the reason an agent holding `users:write` still cannot escalate the
 * user who approved it, or lock a deployment out of its own owner.
 */

const userIdArg = z.object({ userId: z.string().min(1).describe('Id of the user, e.g. usr_…') })

/** Grants name a site by slug — an agent has slugs to hand, not internal ids. */
const siteSlugArg = z.object({
  siteSlug: slugSchema.describe('Slug of the site to grant or revoke access on'),
})

export const userTools = [
  defineTool({
    name: 'list_users',
    title: 'List users',
    description:
      'List everyone with access to this deployment, with their instance role. `pending` means ' +
      'they have been invited but have not set a password yet.',
    args: z.object({}),
    access: { scope: MCP_SCOPES.usersRead, instance: 'admin' },
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const data = await listUsers(ctx.env)
      return {
        structured: data,
        text: data
          .map(
            (user) =>
              `- ${user.id} ${user.email} [${user.role}]${user.pending ? ' (pending)' : ''}`,
          )
          .join('\n'),
      }
    },
  }),

  defineTool({
    name: 'list_user_sites',
    title: 'List a user’s site access',
    description:
      'The per-site grants a user holds. Owners and admins reach every site and so hold no ' +
      'grants — an empty list for one of them is not a lack of access.',
    args: userIdArg,
    access: { scope: MCP_SCOPES.usersRead, instance: 'admin' },
    annotations: { readOnlyHint: true },
    handler: async ({ userId }, ctx) => {
      const data = await listUserSites(ctx.env, userId)
      return {
        structured: data,
        text: data.length
          ? data.map((access) => `- ${access.siteSlug} [${access.role}]`).join('\n')
          : 'No per-site grants.',
      }
    },
  }),

  defineTool({
    name: 'invite_user',
    title: 'Invite user',
    description:
      'Invite somebody by email. This sends them a link to set their own password — no password ' +
      'is ever set on their behalf. An editor or viewer is granted the **active** site, since ' +
      'they would otherwise sign in to nothing; owners and admins reach every site already.',
    args: inviteUserSchema,
    access: { scope: MCP_SCOPES.usersWrite, instance: 'admin' },
    handler: async (input, ctx) => {
      const data = await inviteUser(ctx.env, input, ctx.site.id)
      return {
        structured: data,
        text: `Invited ${data.email} as ${data.role}. They have been emailed a link to set a password.`,
      }
    },
  }),

  defineTool({
    name: 'update_user',
    title: 'Update user',
    description:
      'Change a user’s display name or their instance role. You cannot change your own role — ' +
      'including through this client, which acts as you.',
    args: userIdArg.extend({
      name: z.string().min(1).max(120).optional(),
      role: z.enum(ROLES).optional(),
    }),
    access: { scope: MCP_SCOPES.usersWrite, instance: 'admin' },
    handler: async ({ userId, ...input }, ctx) => {
      const data = await updateUser(ctx.env, userId, input, ctx.actor.id)
      return { structured: data, text: `Updated ${data.email} → ${data.role}.` }
    },
  }),

  defineTool({
    name: 'delete_user',
    title: 'Delete user',
    description:
      'Remove a user from the deployment. Refused for your own account and for the owner. ' +
      'Content they authored stays; the authorship reference is cleared.',
    args: userIdArg,
    access: { scope: MCP_SCOPES.usersWrite, instance: 'admin' },
    annotations: { destructiveHint: true },
    handler: async ({ userId }, ctx) => {
      await deleteUser(ctx.env, userId, ctx.actor.id)
      return { structured: { userId, deleted: true }, text: `Deleted user ${userId}.` }
    },
  }),

  defineTool({
    name: 'grant_site_access',
    title: 'Grant site access',
    description:
      'Give a user a role on one site, or change the role they already have there. Refused for ' +
      'owners and admins, who reach every site without a grant.',
    args: userIdArg.extend(siteSlugArg.shape).extend({ role: z.enum(SITE_ROLES) }),
    access: { scope: MCP_SCOPES.usersWrite, instance: 'admin' },
    handler: async ({ userId, siteSlug, role }, ctx) => {
      const site = await findSite(ctx.env, siteSlug)
      const data = await setUserSiteRole(ctx.env, userId, site.id, role)
      return { structured: data, text: `Granted ${userId} ${role} on "${siteSlug}".` }
    },
  }),

  defineTool({
    name: 'revoke_site_access',
    title: 'Revoke site access',
    description:
      'Remove a user’s grant on one site. For an editor or viewer the grant *is* their access, ' +
      'so this takes the site away from them entirely.',
    args: userIdArg.extend(siteSlugArg.shape),
    access: { scope: MCP_SCOPES.usersWrite, instance: 'admin' },
    annotations: { destructiveHint: true },
    handler: async ({ userId, siteSlug }, ctx) => {
      const site = await findSite(ctx.env, siteSlug)
      await removeUserSiteRole(ctx.env, userId, site.id)
      return {
        structured: { userId, siteSlug, revoked: true },
        text: `Revoked ${userId}'s access to "${siteSlug}".`,
      }
    },
  }),
]
