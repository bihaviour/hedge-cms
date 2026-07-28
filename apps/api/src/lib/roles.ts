import {
  BUILTIN_ROLE_SLUGS,
  BUILTIN_ROLES,
  builtinRole,
  type CreateRoleInput,
  type InstancePermission,
  isInstancePermission,
  type RoleDefinition,
  type SiteRole,
  type UpdateRoleInput,
} from '@hedge/core'
import { asc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type RoleRow, roles, users } from '../db/schema'
import type { Bindings } from '../env'
import { ApiError } from './errors'
import { newId } from './id'

/**
 * Instance roles, factored out so the REST routes and the resolver share one source of truth.
 *
 * There are two: the four built-ins fixed in `@hedge/core`, whose permission sets cannot be edited
 * so an owner can never lock themselves out, and the operator-defined ones in the `roles` table.
 * Everywhere the full picture is needed the two are merged; resolving a *single* built-in slug
 * never touches the database, which keeps the per-request permission lookup free for the common case.
 */

function toRole(row: RoleRow): RoleDefinition {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    permissions: (row.permissions ?? []).filter(isInstancePermission),
    defaultSiteRole: row.defaultSiteRole as SiteRole | null,
    builtin: false,
  }
}

/** Every role a user can be assigned — built-ins first, then custom ones oldest first. */
export async function listRoles(env: Bindings): Promise<RoleDefinition[]> {
  const custom = await getDb(env).select().from(roles).orderBy(asc(roles.createdAt))
  return [...BUILTIN_ROLES, ...custom.map(toRole)]
}

/** One role by slug — built-in (from code) or custom (from the database), or null if neither. */
export async function getRole(env: Bindings, slug: string): Promise<RoleDefinition | null> {
  const builtin = builtinRole(slug)
  if (builtin) return builtin

  const [row] = await getDb(env).select().from(roles).where(eq(roles.slug, slug)).limit(1)
  return row ? toRole(row) : null
}

/** The instance permissions a role slug carries. Unknown slugs resolve to no permissions. */
export async function permissionsForRole(env: Bindings, slug: string): Promise<string[]> {
  const role = await getRole(env, slug)
  return role?.permissions ?? []
}

/**
 * A role may only carry permissions the person defining it already holds. Without this an admin —
 * who can manage roles — could mint a role with `sites:delete` (an owner-only power) and assign it
 * to themselves. Owners hold every permission, so this never constrains them.
 */
function ensureWithinGrant(permissions: InstancePermission[], actorPermissions: string[]): void {
  const beyond = permissions.filter((permission) => !actorPermissions.includes(permission))
  if (beyond.length > 0) {
    throw ApiError.forbidden(
      `You cannot grant a role permissions you do not hold: ${beyond.join(', ')}`,
    )
  }
}

export async function createRole(
  env: Bindings,
  input: CreateRoleInput,
  actorPermissions: string[],
): Promise<RoleDefinition> {
  if (BUILTIN_ROLE_SLUGS.includes(input.slug)) {
    throw ApiError.conflict(`"${input.slug}" is a built-in role`)
  }
  const existing = await getDb(env)
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.slug, input.slug))
    .limit(1)
  if (existing.length > 0) throw ApiError.conflict('A role with that slug already exists')

  ensureWithinGrant(input.permissions, actorPermissions)

  const [row] = await getDb(env)
    .insert(roles)
    .values({
      id: newId('rol'),
      slug: input.slug,
      name: input.name,
      description: input.description,
      permissions: input.permissions,
      defaultSiteRole: input.defaultSiteRole,
    })
    .returning()

  return toRole(row!)
}

export async function updateRole(
  env: Bindings,
  slug: string,
  input: UpdateRoleInput,
  actorPermissions: string[],
): Promise<RoleDefinition> {
  if (builtinRole(slug)) throw ApiError.forbidden('Built-in roles cannot be changed')
  if (input.permissions) ensureWithinGrant(input.permissions, actorPermissions)

  const [row] = await getDb(env)
    .update(roles)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
      ...(input.defaultSiteRole !== undefined ? { defaultSiteRole: input.defaultSiteRole } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(roles.slug, slug))
    .returning()

  if (!row) throw ApiError.notFound('Role')
  return toRole(row)
}

/** Deleting a role is refused while any user still holds it — reassign them first. */
export async function deleteRole(env: Bindings, slug: string): Promise<void> {
  if (builtinRole(slug)) throw ApiError.forbidden('Built-in roles cannot be deleted')

  const db = getDb(env)
  const [assigned] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, slug))
    .limit(1)
  if (assigned) {
    throw ApiError.conflict('This role is still assigned to one or more users')
  }

  const [row] = await db.delete(roles).where(eq(roles.slug, slug)).returning({ id: roles.id })
  if (!row) throw ApiError.notFound('Role')
}
