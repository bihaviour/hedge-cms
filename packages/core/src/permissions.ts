import { z } from 'zod'
import { slugSchema } from './collection'
import { SITE_ROLES } from './site'

/**
 * Instance-level permissions — the deployment-management powers a role can carry.
 *
 * These are the powers that are *not* one site's business: managing users, sites, email and the
 * roles themselves. Site-level content access is governed separately by site roles (see `site.ts`)
 * and is not touched here — an instance role only decides what someone can do to the deployment,
 * and whether they reach every site without a per-site grant.
 *
 * A role is a named set of these. The built-in roles below are fixed; operators define their own
 * under Settings → Roles and assign them to users. `roleAtLeast` (a rank) still orders *site*
 * roles; instance authority is a set membership check against this list.
 */
export const INSTANCE_PERMISSIONS = [
  'users:manage',
  'sites:create',
  'sites:update',
  'sites:delete',
  'sites:access_all',
  'email:manage',
  'roles:manage',
  'system:read',
  'system:update',
] as const

export type InstancePermission = (typeof INSTANCE_PERMISSIONS)[number]

/** Plain-language descriptions, shown beside the switches on the Roles editor. */
export const INSTANCE_PERMISSION_LABELS: Record<InstancePermission, string> = {
  'users:manage': 'Invite users, change their roles, and remove them',
  'sites:create': 'Create new sites',
  'sites:update': 'Rename sites and change their domain and member-signup settings',
  'sites:delete': 'Delete sites and everything in them',
  'sites:access_all': 'Reach every site without an explicit per-site grant',
  'email:manage': 'Manage deployment email settings, templates and the send log',
  'roles:manage': 'Define roles and the permissions they carry',
  'system:read': 'See the deployment version and whether an update is available',
  'system:update': 'Update the deployment to a newer release from the dashboard',
}

export function isInstancePermission(value: string): value is InstancePermission {
  return (INSTANCE_PERMISSIONS as readonly string[]).includes(value)
}

/** True when `permissions` grants `permission`. The one place authority is decided for instance roles. */
export function hasPermission(
  permissions: readonly string[],
  permission: InstancePermission,
): boolean {
  return permissions.includes(permission)
}

/**
 * A role definition as it crosses the wire: the built-in ones and the operator-defined ones read
 * the same, distinguished only by `builtin`. `defaultSiteRole` is the site role a holder is granted
 * on the invite's site when their role does not carry `sites:access_all` — null for roles that do.
 */
export const roleDefinitionSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  permissions: z.array(z.enum(INSTANCE_PERMISSIONS)),
  defaultSiteRole: z.enum(SITE_ROLES).nullable(),
  builtin: z.boolean(),
})

export type RoleDefinition = z.infer<typeof roleDefinitionSchema>

/**
 * The roles every deployment starts with. `owner` is all-powerful and immutable; the other three
 * are sensible defaults an operator supplements with their own.
 *
 * Built-in permission sets live here in code, not in the database, so they cannot drift and no
 * amount of editing can lock an owner out of their own deployment. Custom roles live in the
 * `roles` table; the two are merged wherever the full list is needed.
 */
export const BUILTIN_ROLES: RoleDefinition[] = [
  {
    slug: 'owner',
    name: 'Owner',
    description: 'Full control of the deployment, including deleting sites. Cannot be changed.',
    permissions: [...INSTANCE_PERMISSIONS],
    defaultSiteRole: null,
    builtin: true,
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Runs the deployment — users, sites, email and roles — and reaches every site.',
    permissions: [
      'users:manage',
      'sites:create',
      'sites:update',
      'sites:access_all',
      'email:manage',
      'roles:manage',
      'system:read',
    ],
    defaultSiteRole: null,
    builtin: true,
  },
  {
    slug: 'editor',
    name: 'Editor',
    description: 'Writes content on the sites they are granted access to.',
    permissions: [],
    defaultSiteRole: 'editor',
    builtin: true,
  },
  {
    slug: 'viewer',
    name: 'Viewer',
    description: 'Reads content on the sites they are granted access to.',
    permissions: [],
    defaultSiteRole: 'viewer',
    builtin: true,
  },
]

export const BUILTIN_ROLE_SLUGS = BUILTIN_ROLES.map((role) => role.slug)

/** The built-in definition for a slug, or undefined for a custom (or unknown) one. */
export function builtinRole(slug: string): RoleDefinition | undefined {
  return BUILTIN_ROLES.find((role) => role.slug === slug)
}

/**
 * Creating a role. The slug is permanent — it is what `users.role` stores — so it is set once here
 * and never in the update schema. A route rejects a slug that collides with a built-in or an
 * existing custom role.
 */
export const createRoleSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(60),
  description: z.string().max(200).default(''),
  permissions: z.array(z.enum(INSTANCE_PERMISSIONS)).default([]),
  defaultSiteRole: z.enum(SITE_ROLES).nullable().default('editor'),
})

export type CreateRoleInput = z.infer<typeof createRoleSchema>

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(200).optional(),
  permissions: z.array(z.enum(INSTANCE_PERMISSIONS)).optional(),
  defaultSiteRole: z.enum(SITE_ROLES).nullable().optional(),
})

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>
