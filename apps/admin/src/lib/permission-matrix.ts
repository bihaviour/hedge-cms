import type { RolePermissions, SitePermission, SitePermissionSurface } from '@hedge/core'

/**
 * Ticking one cell of the role matrix (#151).
 *
 * Pure, and out here rather than inside the component, because the rule it carries is the one thing
 * on that screen worth pinning and this workspace has no DOM test setup: **withdrawing a permission
 * from the person withdraws it from everything acting for them.** The reverse does not hold —
 * granting it does not delegate it — which is the whole point of there being three columns.
 *
 * The API refuses a delegation wider than its site column (`rolePermissionsSchema`), so without
 * this a form could only produce a 400 nobody expected.
 */
export function toggleSitePermission(
  value: RolePermissions,
  surface: SitePermissionSurface,
  permission: SitePermission,
  checked: boolean,
): RolePermissions {
  const next: RolePermissions = {
    site: [...value.site],
    mcp: [...value.mcp],
    apiKey: [...value.apiKey],
  }

  const set = (key: SitePermissionSurface, on: boolean) => {
    next[key] = on
      ? [...new Set([...next[key], permission])]
      : next[key].filter((each) => each !== permission)
  }

  set(surface, checked)
  if (surface === 'site' && !checked) {
    set('mcp', false)
    set('apiKey', false)
  }

  return next
}
