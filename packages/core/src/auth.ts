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
  role: z.enum(ROLES),
  createdAt: z.string(),
})

export type User = z.infer<typeof userSchema>

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

export type LoginInput = z.infer<typeof loginSchema>

export const passwordSchema = z.string().min(12, 'must be at least 12 characters').max(200)

export const inviteUserSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  role: z.enum(ROLES).default('editor'),
})

export type InviteUserInput = z.infer<typeof inviteUserSchema>

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
})

export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>

export const API_KEY_SCOPES = [
  'content:read',
  'content:write',
  'media:read',
  'media:write',
  // Managing collection schemas — creating, editing and deleting collections. An admin power,
  // so a key can only carry it if an admin issued it. Used by the MCP endpoint.
  'collections:write',
] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

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
