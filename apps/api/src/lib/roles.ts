import {
  BUILTIN_ROLE_SLUGS,
  BUILTIN_ROLES,
  builtinRole,
  builtinSiteRole,
  type CreateRoleInput,
  type InstancePermission,
  isInstancePermission,
  isSitePermission,
  type RoleDefinition,
  type RolePermissions,
  type SiteRole,
  type UpdateRoleInput,
} from '@hedge/core'
import { asc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type RoleRow, roles, siteUsers, users } from '../db/schema'
import type { Bindings } from '../env'
import { ApiError } from './errors'
import { newId } from './id'

/**
 * Roles, factored out so the REST routes and the resolver share one source of truth.
 *
 * A role answers at **two levels**, and the two are stored differently on purpose:
 *
 * - its **instance** permissions — the deployment-management powers — are fixed in `@hedge/core`
 *   for the four built-ins, so no amount of editing can lock an owner out, and live in the `roles`
 *   table for operator-defined ones.
 * - its **site matrix** (#151) is a row for *every* role including the built-ins, because
 *   "an editor may write but not delete" is the change operators actually come to make, and getting
 *   it wrong locks nobody out: an instance owner resolves to full site authority without consulting
 *   a role at all.
 *
 * Resolving a built-in's *instance* half therefore still never touches the database, which keeps
 * the per-request permission lookup free for the common case. Its site half is one row read, on
 * routes that were going to read `site_users` anyway.
 */

/** The three matrix columns off a row, keeping only permissions this build still recognises. */
function toMatrix(row: {
  sitePermissions: string[] | null
  mcpPermissions: string[] | null
  apiKeyPermissions: string[] | null
}): RolePermissions {
  return {
    site: (row.sitePermissions ?? []).filter(isSitePermission),
    mcp: (row.mcpPermissions ?? []).filter(isSitePermission),
    apiKey: (row.apiKeyPermissions ?? []).filter(isSitePermission),
  }
}

const EMPTY_MATRIX: RolePermissions = { site: [], mcp: [], apiKey: [] }

/**
 * The matrix a site-role slug carries: the row if there is one, else what that slug has always
 * meant, else nothing.
 *
 * The middle case is the one worth stating. Migration `0018` seeds the three built-ins, so a
 * migrated deployment answers from the database — but a slug with no row must still resolve to the
 * set it granted before the matrix existed rather than to silence, or the window between a deploy
 * and its migration is a window where every editor loses their access.
 */
export function matrixForSlug(row: RoleRow | undefined, slug: string): RolePermissions {
  if (row) return toMatrix(row)
  return builtinSiteRole(slug) ?? EMPTY_MATRIX
}

function toRole(row: RoleRow): RoleDefinition {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    permissions: (row.permissions ?? []).filter(isInstancePermission),
    defaultSiteRole: row.defaultSiteRole as SiteRole | null,
    builtin: false,
    sitePermissions: toMatrix(row),
  }
}

/**
 * A built-in as the deployment actually holds it: instance half from code, site matrix from its
 * seeded row. Both are true at once, which is why this cannot be either half alone.
 */
function mergeBuiltin(builtin: RoleDefinition, row: RoleRow | undefined): RoleDefinition {
  return { ...builtin, sitePermissions: matrixForSlug(row, builtin.slug) }
}

/** Every role a user can be assigned — built-ins first, then custom ones oldest first. */
export async function listRoles(env: Bindings): Promise<RoleDefinition[]> {
  const rows = await getDb(env).select().from(roles).orderBy(asc(roles.createdAt))
  const bySlug = new Map(rows.map((row) => [row.slug, row]))

  return [
    ...BUILTIN_ROLES.map((builtin) => mergeBuiltin(builtin, bySlug.get(builtin.slug))),
    // A built-in's row is its matrix, not a second role — listing it again would show `editor`
    // twice on the Roles page and offer two of them at an invite.
    ...rows.filter((row) => !BUILTIN_ROLE_SLUGS.includes(row.slug)).map(toRole),
  ]
}

/** One role by slug — built-in (from code) or custom (from the database), or null if neither. */
export async function getRole(env: Bindings, slug: string): Promise<RoleDefinition | null> {
  const [row] = await getDb(env).select().from(roles).where(eq(roles.slug, slug)).limit(1)

  const builtin = builtinRole(slug)
  if (builtin) return mergeBuiltin(builtin, row)

  return row ? toRole(row) : null
}

/**
 * The instance permissions a role slug carries. Unknown slugs resolve to no permissions.
 *
 * Deliberately not `getRole`: this runs on **every authenticated request** (`resolveSessionActor`),
 * and a built-in's instance half is in code, so asking the database for it would buy a D1 round
 * trip per request to learn something this build already knows.
 */
export async function permissionsForRole(env: Bindings, slug: string): Promise<string[]> {
  const builtin = builtinRole(slug)
  if (builtin) return builtin.permissions

  const [row] = await getDb(env)
    .select({ permissions: roles.permissions })
    .from(roles)
    .where(eq(roles.slug, slug))
    .limit(1)

  return (row?.permissions ?? []).filter(isInstancePermission)
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

/**
 * The same argument, one level down: a role's site matrix is authority over *every* site, so
 * defining one is only meaningful for somebody who reaches every site themselves.
 *
 * `roles:manage` is held by `admin` and `owner`, both of which carry `sites:access_all`, so this
 * refuses nothing that works today. It exists for the custom role that carries `roles:manage`
 * without it — otherwise that person could define a role granting `entries:delete` everywhere and
 * hand it to somebody, which is authority they do not hold and could not have granted directly.
 */
function ensureMayDefineSiteMatrix(
  matrix: RolePermissions | undefined,
  actorPermissions: string[],
): void {
  if (!matrix) return
  const grants = matrix.site.length + matrix.mcp.length + matrix.apiKey.length > 0
  if (grants && !actorPermissions.includes('sites:access_all')) {
    throw ApiError.forbidden(
      'Defining what a role may do on a site requires access to every site (`sites:access_all`)',
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
  ensureMayDefineSiteMatrix(input.sitePermissions, actorPermissions)

  const [row] = await getDb(env)
    .insert(roles)
    .values({
      id: newId('rol'),
      slug: input.slug,
      name: input.name,
      description: input.description,
      permissions: input.permissions,
      sitePermissions: input.sitePermissions.site,
      mcpPermissions: input.sitePermissions.mcp,
      apiKeyPermissions: input.sitePermissions.apiKey,
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
  const builtin = builtinRole(slug)

  // A built-in's *site* matrix is editable and its instance half is not, which is the whole of
  // #151's "every role is editable" — narrowing what an editor may do to content is the change
  // operators come to make, and it locks nobody out. Its deployment powers still cannot move: that
  // is the half that could leave a deployment with no owner.
  if (builtin) {
    const instanceEdit =
      input.name !== undefined ||
      input.description !== undefined ||
      input.permissions !== undefined ||
      input.defaultSiteRole !== undefined
    if (instanceEdit) {
      throw ApiError.forbidden(
        `"${slug}" is a built-in role — only what it may do on a site can be changed`,
      )
    }
  }

  if (input.permissions) ensureWithinGrant(input.permissions, actorPermissions)
  ensureMayDefineSiteMatrix(input.sitePermissions, actorPermissions)

  const [row] = await getDb(env)
    .update(roles)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
      ...(input.defaultSiteRole !== undefined ? { defaultSiteRole: input.defaultSiteRole } : {}),
      ...(input.sitePermissions !== undefined
        ? {
            sitePermissions: input.sitePermissions.site,
            mcpPermissions: input.sitePermissions.mcp,
            apiKeyPermissions: input.sitePermissions.apiKey,
          }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(roles.slug, slug))
    .returning()

  if (!row) throw ApiError.notFound('Role')
  return builtin ? mergeBuiltin(builtin, row) : toRole(row)
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

  // And on a *site*, since #151 — the same slug is assignable there, and deleting the row out from
  // under a grant would leave that person resolving to no permissions with nothing saying why.
  const [granted] = await db
    .select({ userId: siteUsers.userId })
    .from(siteUsers)
    .where(eq(siteUsers.role, slug))
    .limit(1)
  if (granted) {
    throw ApiError.conflict('This role is still assigned to one or more users on a site')
  }

  const [row] = await db.delete(roles).where(eq(roles.slug, slug)).returning({ id: roles.id })
  if (!row) throw ApiError.notFound('Role')
}
