import { z } from 'zod'

/**
 * Site-level permissions — what somebody may do *inside one site*, per item and per verb (#151).
 *
 * This replaces a rank with a set. Site access used to be `admin > editor > viewer` and every gate
 * asked "at least editor?", which welded verbs together: deleting an entry and updating one were
 * one power because they were one role. "Can write, cannot delete" was not expressible for a
 * person, for an agent, or for a machine — and it is the thing operators actually ask for.
 *
 * Instance permissions (`permissions.ts`) are unchanged and answer a different question: what
 * somebody may do to the *deployment* — users, sites, email, the roles themselves. The two compose.
 *
 * Nothing reads these yet. This file is the vocabulary; the stages behind #151 move the gates onto
 * it, and until then the ranks in `site.ts` are still what decides.
 */

/**
 * `send` is the one verb outside CRUD, and it is here rather than folded into `update` because a
 * newsletter reaching its audience cannot be recalled — an author who may draft and edit is not
 * automatically somebody who may press send. `SITE_PERMISSION_GRID` says which items carry it.
 */
export const SITE_PERMISSION_VERBS = ['create', 'read', 'update', 'delete', 'send'] as const
export type SitePermissionVerb = (typeof SITE_PERMISSION_VERBS)[number]

/** The rows of the matrix: everything a site owns. Users, sites and email are instance-level. */
export const SITE_PERMISSION_ITEMS = [
  'entries',
  'media',
  'collections',
  'newsletters',
  'subscribers',
  'members',
  'api_keys',
  'analytics',
] as const

export type SitePermissionItem = (typeof SITE_PERMISSION_ITEMS)[number]

/**
 * Which verbs each item actually has — not every row is a full CRUD row, and the editor renders
 * from this rather than showing checkboxes that do nothing. Analytics is derived from a beacon
 * nobody in the CMS writes, so it reads and nothing else.
 *
 * Newsletter *templates* are deliberately not their own item: they exist to be sent as newsletters
 * and share their gate today. Splitting them would add a row nobody has a different answer for.
 */
export const SITE_PERMISSION_GRID = {
  entries: ['create', 'read', 'update', 'delete'],
  media: ['create', 'read', 'update', 'delete'],
  collections: ['create', 'read', 'update', 'delete'],
  newsletters: ['create', 'read', 'update', 'delete', 'send'],
  subscribers: ['create', 'read', 'update', 'delete'],
  members: ['create', 'read', 'update', 'delete'],
  api_keys: ['create', 'read', 'update', 'delete'],
  analytics: ['read'],
} as const satisfies Record<SitePermissionItem, readonly SitePermissionVerb[]>

/**
 * Every permission, written out rather than derived from the grid above.
 *
 * A generated list cannot be a `z.enum`, and the whole value of this being a union is that a typo
 * in a route gate is a compile error rather than a permission nobody holds. `site-permissions.test`
 * asserts the list and the grid describe the same set, in both directions, so the duplication
 * cannot drift.
 */
export const SITE_PERMISSIONS = [
  'entries:create',
  'entries:read',
  'entries:update',
  'entries:delete',
  'media:create',
  'media:read',
  'media:update',
  'media:delete',
  'collections:create',
  'collections:read',
  'collections:update',
  'collections:delete',
  'newsletters:create',
  'newsletters:read',
  'newsletters:update',
  'newsletters:delete',
  'newsletters:send',
  'subscribers:create',
  'subscribers:read',
  'subscribers:update',
  'subscribers:delete',
  'members:create',
  'members:read',
  'members:update',
  'members:delete',
  'api_keys:create',
  'api_keys:read',
  'api_keys:update',
  'api_keys:delete',
  'analytics:read',
] as const

export type SitePermission = (typeof SITE_PERMISSIONS)[number]

/** Plain-language descriptions, the way `INSTANCE_PERMISSION_LABELS` already works for the other
 * half. The matrix editor renders from these, and an unlabelled permission reaches an operator as a
 * bare `subscribers:delete` nobody can evaluate. */
export const SITE_PERMISSION_LABELS: Record<SitePermission, string> = {
  'entries:create': 'Create entries',
  'entries:read': 'Read entries, including drafts, revisions and versions',
  'entries:update': 'Edit entries, restore a revision, and link translations',
  'entries:delete': 'Delete entries',
  'media:create': 'Upload files',
  'media:read': 'Browse the media library',
  'media:update': 'Edit a file’s filename and alt text',
  'media:delete': 'Delete files',
  'collections:create': 'Create collections',
  'collections:read': 'See collections and their fields',
  'collections:update': 'Change a collection’s fields and settings',
  'collections:delete': 'Delete collections and every entry in them',
  'newsletters:create': 'Draft newsletters and templates',
  'newsletters:read': 'Read newsletters and templates',
  'newsletters:update': 'Edit newsletters and templates',
  'newsletters:delete': 'Delete newsletters and templates',
  'newsletters:send': 'Send a newsletter — to a test address, and to the audience',
  'subscribers:create': 'Add subscribers',
  'subscribers:read': 'See the subscriber list and their addresses',
  'subscribers:update': 'Edit a subscriber',
  'subscribers:delete': 'Remove subscribers',
  'members:create': 'Add website members and invite them',
  'members:read': 'See the member list and their addresses',
  'members:update': 'Edit a member, including blocking one',
  'members:delete': 'Remove members',
  'api_keys:create': 'Issue API keys for this site',
  'api_keys:read': 'See this site’s API keys',
  'api_keys:update': 'Rename and rotate API keys',
  'api_keys:delete': 'Delete API keys',
  'analytics:read': 'See this site’s traffic',
}

export function isSitePermission(value: string): value is SitePermission {
  return (SITE_PERMISSIONS as readonly string[]).includes(value)
}

/**
 * True when `permissions` grants `permission`. The one place a site-level decision is made — there
 * is no ordering to fall back on, and a permission absent from the set is refused however senior
 * the role sounds.
 */
export function hasSitePermission(
  permissions: readonly string[],
  permission: SitePermission,
): boolean {
  return permissions.includes(permission)
}

/**
 * The three surfaces one role answers for.
 *
 * `site` is the person: the admin UI and the management REST API. `mcp` is an MCP client acting as
 * them, and `apiKey` is a key they issued. The last two are *delegations of the first* — which is
 * why they are columns on one role rather than three roles to keep in step. A user is configured
 * once.
 */
export const SITE_PERMISSION_SURFACES = ['site', 'mcp', 'apiKey'] as const
export type SitePermissionSurface = (typeof SITE_PERMISSION_SURFACES)[number]

const permissionSet = z.array(z.enum(SITE_PERMISSIONS))

/**
 * A role's three columns.
 *
 * **`mcp` and `apiKey` must be subsets of `site`, and that is enforced rather than advised.** An
 * agent acts as the person who approved it and a key acts for the person who issued it, so a
 * delegation wider than the delegator is not a configuration mistake to warn about — it is a
 * sentence with no meaning, and letting it be stored would put an authority in the database that
 * nothing in the deployment can honestly resolve.
 */
export const rolePermissionsSchema = z
  .object({
    site: permissionSet.default([]),
    mcp: permissionSet.default([]),
    apiKey: permissionSet.default([]),
  })
  .superRefine((permissions, ctx) => {
    for (const { surface, permission } of delegationsBeyondSite(permissions)) {
      ctx.addIssue({
        code: 'custom',
        path: [surface],
        message: `"${permission}" is not granted on the site, so it cannot be delegated to ${surface === 'mcp' ? 'an MCP client' : 'an API key'}`,
      })
    }
  })

export type RolePermissions = z.infer<typeof rolePermissionsSchema>

/**
 * Every delegated permission the site column does not carry — the offenders, not a boolean, so the
 * API can name them and the editor can point at the cell.
 */
export function delegationsBeyondSite(permissions: {
  site: readonly string[]
  mcp: readonly string[]
  apiKey: readonly string[]
}): { surface: 'mcp' | 'apiKey'; permission: string }[] {
  const site = new Set(permissions.site)

  return (['mcp', 'apiKey'] as const).flatMap((surface) =>
    permissions[surface]
      .filter((permission) => !site.has(permission))
      .map((permission) => ({ surface, permission })),
  )
}

/** The column that governs one surface. `site` for a person, the delegated ones for the other two. */
export function permissionsForSurface(
  permissions: RolePermissions,
  surface: SitePermissionSurface,
): readonly SitePermission[] {
  return permissions[surface]
}

/** Every site permission there is — what an instance owner resolves to, and what site `admin` holds. */
export const ALL_SITE_PERMISSIONS: readonly SitePermission[] = SITE_PERMISSIONS

/** A role that delegates everything it holds: the shape every built-in ships with. */
const delegatingFully = (site: readonly SitePermission[]): RolePermissions => ({
  site: [...site],
  mcp: [...site],
  apiKey: [...site],
})

/**
 * What `editor` means today, verb by verb, read off the routes it currently passes: entries and
 * media in full, collections read-only (creating one is `admin`), newsletters short of sending,
 * subscribers in full, the member *list* but no member management, no keys, and traffic.
 */
const EDITOR_SITE_PERMISSIONS: readonly SitePermission[] = [
  'entries:create',
  'entries:read',
  'entries:update',
  'entries:delete',
  'media:create',
  'media:read',
  'media:update',
  'media:delete',
  'collections:read',
  'newsletters:create',
  'newsletters:read',
  'newsletters:update',
  'newsletters:delete',
  'subscribers:create',
  'subscribers:read',
  'subscribers:update',
  'subscribers:delete',
  'members:read',
  'analytics:read',
]

/** And `viewer`: the four things a `requireSiteRole('viewer')` route serves. */
const VIEWER_SITE_PERMISSIONS: readonly SitePermission[] = [
  'entries:read',
  'media:read',
  'collections:read',
  'analytics:read',
]

/**
 * The three site roles every deployment already has, expanded into sets.
 *
 * **These are the migration's seed, and they have to match the ranks exactly.** Every existing
 * `site_users` row keeps its slug, so the day after the migration a person's access is whatever
 * this table says it is — a permission left out here is access silently removed from everyone
 * holding that role, on every site. `site-permissions.test.ts` pins each set against the audit in
 * #151 for that reason.
 *
 * Every column delegates in full, because that is what is true today: an MCP client acting as an
 * editor is limited by the editor's site role, and a key is issued by a site admin. Narrowing a
 * delegated column is the new power this buys an operator, and it starts from where they are.
 */
export const BUILTIN_SITE_ROLES = [
  {
    slug: 'admin',
    name: 'Site admin',
    description: 'Full control of this site — content, keys, members and sending.',
    permissions: delegatingFully(ALL_SITE_PERMISSIONS),
  },
  {
    slug: 'editor',
    name: 'Editor',
    description: 'Writes content, media and newsletters. Cannot change the model or send.',
    permissions: delegatingFully(EDITOR_SITE_PERMISSIONS),
  },
  {
    slug: 'viewer',
    name: 'Viewer',
    description: 'Reads content and traffic, and changes nothing.',
    permissions: delegatingFully(VIEWER_SITE_PERMISSIONS),
  },
] as const satisfies readonly {
  slug: string
  name: string
  description: string
  permissions: RolePermissions
}[]

/**
 * The built-in site matrix for a slug, or undefined for a custom one.
 *
 * This is the **fallback**, not the source of truth: stage 2 seeds these three as editable rows, so
 * a deployment answers from the database. It matters for the one case the database cannot cover — a
 * slug whose row is missing, which is what a deployment looks like between the code landing and the
 * migration running, and what a unit test with no database looks like always. Answering "the set
 * this role has always carried" there is strictly better than answering "nothing".
 */
export function builtinSiteRole(slug: string): RolePermissions | undefined {
  const found = BUILTIN_SITE_ROLES.find((role) => role.slug === slug)
  return found ? { ...found.permissions } : undefined
}
