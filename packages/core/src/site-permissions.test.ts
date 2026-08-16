import { describe, expect, test } from 'bun:test'
import {
  ALL_SITE_PERMISSIONS,
  BUILTIN_SITE_ROLES,
  delegationsBeyondSite,
  hasSitePermission,
  isSitePermission,
  rolePermissionsSchema,
  SITE_PERMISSION_GRID,
  SITE_PERMISSION_LABELS,
  SITE_PERMISSIONS,
} from './site-permissions'

/**
 * The vocabulary behind #151, and two claims that nothing else can hold.
 *
 * The built-in sets are the migration's seed: every existing `site_users` row keeps its slug, so
 * a permission missing from one of these is access silently removed from everyone holding that
 * role, on every site, the day it ships. They are therefore written out again here, from the route
 * audit rather than from the constant — a change has to be made twice, deliberately, or this fails.
 *
 * And a delegation wider than the person delegating it must be unstorable, not merely discouraged.
 */

const role = (slug: string) => BUILTIN_SITE_ROLES.find((r) => r.slug === slug)!

/** Both sides of a set comparison as plain sorted strings, so a literal list can be the expectation. */
const sorted = (permissions: readonly string[]) => [...permissions].sort()

describe('the catalog', () => {
  test('the written list and the grid describe the same set, both ways', () => {
    const fromGrid = Object.entries(SITE_PERMISSION_GRID).flatMap(([item, verbs]) =>
      verbs.map((verb) => `${item}:${verb}`),
    )

    expect(sorted(SITE_PERMISSIONS)).toEqual(sorted(fromGrid))
  })

  test('every permission carries a label', () => {
    // A permission with no label reaches an operator as a bare `subscribers:delete` on the matrix.
    for (const permission of SITE_PERMISSIONS) {
      expect(SITE_PERMISSION_LABELS[permission]).toBeTruthy()
    }
    expect(Object.keys(SITE_PERMISSION_LABELS)).toHaveLength(SITE_PERMISSIONS.length)
  })

  test('analytics reads and nothing else', () => {
    // It is written by a public beacon, not by anyone in the CMS — three dead checkboxes otherwise.
    expect(SITE_PERMISSION_GRID.analytics).toEqual(['read'])
  })

  test('newsletters carry send, and it is the only item that does', () => {
    const withSend = Object.entries(SITE_PERMISSION_GRID)
      .filter(([, verbs]) => (verbs as readonly string[]).includes('send'))
      .map(([item]) => item)

    expect(withSend).toEqual(['newsletters'])
  })

  test('isSitePermission rejects an instance permission', () => {
    expect(isSitePermission('entries:delete')).toBe(true)
    expect(isSitePermission('users:manage')).toBe(false)
    expect(isSitePermission('entries:publish')).toBe(false)
  })

  test('hasSitePermission is set membership, with no rank behind it', () => {
    const editor = role('editor').permissions.site

    expect(hasSitePermission(editor, 'entries:delete')).toBe(true)
    // The case the whole epic exists for: an editor may read the model and not change it, and no
    // "at least editor" comparison can be talked into saying otherwise.
    expect(hasSitePermission(editor, 'collections:create')).toBe(false)
  })
})

describe('the built-in sets, against the route audit', () => {
  test('site admin holds everything', () => {
    // Every site route passed for a site admin before #154, and every one of them still does.
    expect(sorted(role('admin').permissions.site)).toEqual(sorted(ALL_SITE_PERMISSIONS))
  })

  test('editor is content and newsletters, short of sending, the model and keys', () => {
    expect(sorted(role('editor').permissions.site)).toEqual(
      sorted([
        'analytics:read',
        'collections:read',
        'entries:create',
        'entries:delete',
        'entries:read',
        'entries:update',
        'media:create',
        'media:delete',
        'media:read',
        'media:update',
        'members:read',
        'newsletters:create',
        'newsletters:delete',
        'newsletters:read',
        'newsletters:update',
        'subscribers:create',
        'subscribers:delete',
        'subscribers:read',
        'subscribers:update',
      ]),
    )
  })

  test('editor cannot send, change the model, manage members or touch keys', () => {
    const editor = role('editor').permissions.site

    // `POST /newsletters/:id/send` and `…/test` are `admin` today; so are the collection writes,
    // every member route past the list, and the whole of `/api-keys`.
    for (const withheld of [
      'newsletters:send',
      'collections:create',
      'collections:update',
      'collections:delete',
      'members:create',
      'members:update',
      'members:delete',
      'api_keys:create',
      'api_keys:read',
      'api_keys:update',
      'api_keys:delete',
    ] as const) {
      expect(hasSitePermission(editor, withheld)).toBe(false)
    }
  })

  test('viewer is the four reads a viewer route serves', () => {
    expect(sorted(role('viewer').permissions.site)).toEqual(
      sorted(['analytics:read', 'collections:read', 'entries:read', 'media:read']),
    )
  })

  test('every built-in delegates exactly what it holds', () => {
    // What is true today: an MCP client is limited by the approving user's site role, and a key is
    // issued by a site admin. Narrowing a column is the new power, and it starts from here.
    for (const builtin of BUILTIN_SITE_ROLES) {
      expect(builtin.permissions.mcp).toEqual(builtin.permissions.site)
      expect(builtin.permissions.apiKey).toEqual(builtin.permissions.site)
    }
  })

  test('the three slugs are exactly the site roles that exist today', () => {
    expect(BUILTIN_SITE_ROLES.map((r) => r.slug)).toEqual(['admin', 'editor', 'viewer'])
  })
})

describe('a delegation cannot exceed the person delegating it', () => {
  test('the schema refuses an mcp permission the site column does not carry', () => {
    const result = rolePermissionsSchema.safeParse({
      site: ['entries:read'],
      mcp: ['entries:read', 'entries:delete'],
      apiKey: [],
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['mcp'])
    expect(result.error?.issues[0]?.message).toContain('entries:delete')
  })

  test('and an apiKey one, named separately', () => {
    const result = rolePermissionsSchema.safeParse({
      site: ['media:read'],
      mcp: [],
      apiKey: ['media:delete'],
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['apiKey'])
  })

  test('narrower and equal delegations are both fine', () => {
    expect(
      rolePermissionsSchema.safeParse({
        site: ['entries:read', 'entries:update', 'entries:delete'],
        mcp: ['entries:read', 'entries:update'],
        apiKey: ['entries:read', 'entries:update', 'entries:delete'],
      }).success,
    ).toBe(true)
  })

  test('an empty role parses, and delegates nothing', () => {
    const parsed = rolePermissionsSchema.parse({})
    expect(parsed).toEqual({ site: [], mcp: [], apiKey: [] })
  })

  test('delegationsBeyondSite names every offender rather than answering yes or no', () => {
    // The editor points at a cell with this; a boolean would only say the form is wrong.
    expect(
      delegationsBeyondSite({
        site: ['entries:read'],
        mcp: ['entries:delete'],
        apiKey: ['media:create', 'entries:read'],
      }),
    ).toEqual([
      { surface: 'mcp', permission: 'entries:delete' },
      { surface: 'apiKey', permission: 'media:create' },
    ])
  })

  test('every built-in survives its own validator', () => {
    for (const builtin of BUILTIN_SITE_ROLES) {
      expect(rolePermissionsSchema.safeParse(builtin.permissions).success).toBe(true)
    }
  })
})
