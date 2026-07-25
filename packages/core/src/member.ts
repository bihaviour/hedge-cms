import { z } from 'zod'
import { passwordSchema } from './auth'

/**
 * Members are the audience of a site, not operators of the CMS. They live in their own table,
 * belong to exactly one site, and authenticate with a bearer token rather than the admin session
 * cookie — so no credential a member holds can ever resolve to a CMS user.
 */

/** Header a website sends to prove a request is coming from a signed-in member. */
export const MEMBER_TOKEN_HEADER = 'x-member-token'

export const MEMBER_STATUSES = ['active', 'blocked'] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]

export const memberSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  email: z.email(),
  name: z.string(),
  status: z.enum(MEMBER_STATUSES),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
})

export type Member = z.infer<typeof memberSchema>

export const memberRegisterSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  password: passwordSchema,
})

export type MemberRegisterInput = z.infer<typeof memberRegisterSchema>

export const memberLoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

export type MemberLoginInput = z.infer<typeof memberLoginSchema>

/** What a member gets back from register and login — the token is theirs to store. */
export const memberSessionSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  member: memberSchema,
})

export type MemberSession = z.infer<typeof memberSessionSchema>

/** Admin-side creation: no password, the member sets one by registering with the same email. */
export const createMemberSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  password: passwordSchema.optional(),
})

export type CreateMemberInput = z.infer<typeof createMemberSchema>

export const updateMemberSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
})

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>
