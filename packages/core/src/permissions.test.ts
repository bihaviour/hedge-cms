import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_ROLES,
  builtinRole,
  createRoleSchema,
  INSTANCE_PERMISSION_LABELS,
  INSTANCE_PERMISSIONS,
  isInstancePermission,
} from './index'

describe('built-in roles', () => {
  test('owner carries every instance permission', () => {
    const owner = builtinRole('owner')
    expect(owner?.permissions).toEqual([...INSTANCE_PERMISSIONS])
  })

  // Deleting a site is owner-only, so the built-in admin must not carry it — this is what keeps
  // `delete_site` and `DELETE /sites/:slug` out of an admin's reach.
  test('admin runs the deployment but cannot delete sites', () => {
    const admin = builtinRole('admin')
    expect(admin?.permissions).toContain('users:manage')
    expect(admin?.permissions).toContain('sites:access_all')
    expect(admin?.permissions).not.toContain('sites:delete')
  })

  test('editor and viewer hold no instance permissions and default to their site role', () => {
    expect(builtinRole('editor')).toMatchObject({ permissions: [], defaultSiteRole: 'editor' })
    expect(builtinRole('viewer')).toMatchObject({ permissions: [], defaultSiteRole: 'viewer' })
  })

  test('only owner and admin reach every site', () => {
    const withAllSites = BUILTIN_ROLES.filter((role) =>
      role.permissions.includes('sites:access_all'),
    ).map((role) => role.slug)
    expect(withAllSites).toEqual(['owner', 'admin'])
  })

  test('an unknown slug is not a built-in', () => {
    expect(builtinRole('content-manager')).toBeUndefined()
  })
})

describe('instance permissions', () => {
  // A permission with no label would reach the Roles editor as a bare id nobody can evaluate — the
  // same failure mode the MCP scope labels guard against.
  test('every permission has a label', () => {
    for (const permission of INSTANCE_PERMISSIONS) {
      expect(INSTANCE_PERMISSION_LABELS[permission]).toBeTruthy()
    }
  })

  test('isInstancePermission recognises the catalog and nothing else', () => {
    expect(isInstancePermission('users:manage')).toBe(true)
    expect(isInstancePermission('not:real')).toBe(false)
  })
})

describe('createRoleSchema', () => {
  test('defaults description, permissions and site role', () => {
    const parsed = createRoleSchema.parse({ slug: 'support', name: 'Support' })
    expect(parsed).toMatchObject({
      slug: 'support',
      name: 'Support',
      description: '',
      permissions: [],
      defaultSiteRole: 'editor',
    })
  })

  test('rejects a permission outside the catalog', () => {
    expect(() =>
      createRoleSchema.parse({ slug: 'x', name: 'X', permissions: ['not:real'] }),
    ).toThrow()
  })
})
