import { z } from 'zod'

export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

/** Higher number wins. Used by `requireRole` on the API side. */
const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
}

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

export const userSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  /** The role's slug — a built-in (`owner`/`admin`/`editor`/`viewer`) or a custom one. */
  role: z.string(),
  /**
   * The instance permissions that role carries, resolved server-side. Drives the admin's UI gating
   * (which is cosmetic — the server check is the real one). Empty for a role with no instance powers.
   */
  permissions: z.array(z.string()),
  createdAt: z.string(),
})

export type User = z.infer<typeof userSchema>

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

export type LoginInput = z.infer<typeof loginSchema>

export const passwordSchema = z.string().min(12, 'must be at least 12 characters').max(200)

/**
 * Inviting is the only way to add a user, and it carries no password: the invitee sets their own
 * from the emailed link. Strict for the same reason as `createMemberSchema` — a password sent here
 * is an error worth reporting, not a field to quietly ignore.
 */
export const inviteUserSchema = z.strictObject({
  email: z.email(),
  name: z.string().min(1).max(120),
  /** A role slug — built-in or custom. The route rejects one that names no existing role. */
  role: z.string().default('editor'),
})

export type InviteUserInput = z.infer<typeof inviteUserSchema>

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
})

export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>

/**
 * One place a user is signed in. The session token is the credential, so it is never part of this —
 * the admin revokes by id.
 */
export const userSessionSchema = z.object({
  id: z.string(),
  /** True for the session making the request, which the UI marks rather than offers to revoke. */
  current: z.boolean(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
})

export type UserSession = z.infer<typeof userSessionSchema>

/**
 * OAuth scopes an MCP client may request, one read/write pair per area of the CMS. They bound what
 * a *delegated* client can do; the user's own role still applies on top, so granting
 * `collections:write` to an editor's client does not let it rewrite schemas, and granting
 * `users:write` to anyone below instance admin does not let it manage users.
 *
 * The pairing is deliberate. A client that only ever reads — a documentation assistant, a search
 * indexer — asks for the `:read` half and cannot be talked into a write by a prompt it was fed.
 */
export const MCP_SCOPES = {
  collectionsRead: 'collections:read',
  collectionsWrite: 'collections:write',
  entriesRead: 'entries:read',
  entriesWrite: 'entries:write',
  mediaRead: 'media:read',
  mediaWrite: 'media:write',
  newslettersRead: 'newsletters:read',
  newslettersWrite: 'newsletters:write',
  sitesRead: 'sites:read',
  sitesWrite: 'sites:write',
  usersRead: 'users:read',
  usersWrite: 'users:write',
  keysRead: 'keys:read',
  keysWrite: 'keys:write',
} as const

export type McpScope = (typeof MCP_SCOPES)[keyof typeof MCP_SCOPES]

/** Every MCP scope, for the OAuth server's metadata and the consent screen. */
export const MCP_SCOPE_LIST = Object.values(MCP_SCOPES) as McpScope[]

/**
 * Plain-language descriptions of each scope, shown on the consent screen. They live here rather
 * than in the admin because the same wording has to survive any client that reads the OAuth
 * metadata — and because a consent screen that undersells what it is granting is the one bug in
 * this flow with no technical symptom.
 */
export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  'collections:read': 'Read this site’s collections and their fields',
  // Deleting a collection takes its entries with it, which is how this reaches content.
  'collections:write': 'Create, change and delete this site’s collections',
  'entries:read': 'Read this site’s entries, including unpublished drafts',
  'entries:write': 'Create, edit, publish and delete this site’s entries',
  'media:read': 'List this site’s uploaded media',
  'media:write': 'Rename, re-caption and delete this site’s media',
  'newsletters:read': 'Read this site’s newsletters, templates and subscriber list',
  'newsletters:write': 'Write newsletters and templates, and manage subscribers',
  'sites:read': 'See the sites you have access to and their settings',
  'sites:write': 'Create sites and change their settings',
  'users:read': 'See who has access to this deployment',
  'users:write': 'Invite users, change their roles, and remove them',
  'keys:read': 'List this site’s API keys',
  'keys:write': 'Issue and revoke API keys for this site',
}

/** Admin route that asks the operator to approve an MCP client's authorization request. */
export const OAUTH_CONSENT_PATH = '/oauth/consent'

/** An MCP client a user has approved. Ending it revokes both its tokens and the consent. */
export const authorizedClientSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  authorizedAt: z.string(),
})

export type AuthorizedClient = z.infer<typeof authorizedClientSchema>

/**
 * What a key may do, and — with the route prefixes in the Worker — where it may go.
 *
 * `content:read` alone is the *delivery* key a public website holds: it reaches the delivery API
 * and nothing else, so it only ever sees published entries. Adding any `:write` scope makes it an
 * authoring key, which also reaches the content and media management routes. Neither kind can
 * touch users, sites, members, email or the key routes themselves.
 */
export const API_KEY_SCOPES = [
  'content:read',
  'content:write',
  'media:read',
  'media:write',
  // Managing collection schemas — creating, editing and deleting collections, which takes their
  // entries with them. A site-admin power, and issuing any key already requires being one.
  'collections:write',
] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

/** Plain-language descriptions of each scope, shown beside the switches in the admin. */
export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'content:read':
    'Read published content through the delivery API, and drafts when paired with a write scope',
  'content:write': 'Create, edit and delete entries',
  'media:read': 'List uploaded media',
  'media:write': 'Upload, rename and delete media',
  'collections:write': 'Create, change and delete collections — and the entries inside them',
}

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['content:read']),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
})

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First 8 characters of the key, kept so the UI can identify it after creation. */
  prefix: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
})

export type ApiKey = z.infer<typeof apiKeySchema>
