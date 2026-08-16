import { describe, expect, test } from 'bun:test'
import type { RolePermissions } from '@hedge/core'
import { toggleSitePermission } from './permission-matrix'

/**
 * The one rule the matrix editor carries that the server also enforces, so the two cannot disagree:
 * a delegated column is a subset of the site column. The editor's job is to make that obvious
 * rather than to discover it as a 400.
 */

const start: RolePermissions = {
  site: ['entries:read', 'entries:delete'],
  mcp: ['entries:read', 'entries:delete'],
  apiKey: ['entries:delete'],
}

describe('ticking a cell', () => {
  test('withdrawing from the site withdraws from everything acting for them', () => {
    const next = toggleSitePermission(start, 'site', 'entries:delete', false)

    expect(next.site).toEqual(['entries:read'])
    expect(next.mcp).toEqual(['entries:read'])
    expect(next.apiKey).toEqual([])
  })

  test('but granting on the site delegates nothing', () => {
    // The asymmetry is the whole point of three columns. A role that may delete is not a role that
    // lets an agent delete.
    const next = toggleSitePermission(start, 'site', 'media:delete', true)

    expect(next.site).toContain('media:delete')
    expect(next.mcp).not.toContain('media:delete')
    expect(next.apiKey).not.toContain('media:delete')
  })

  test('a delegated column moves on its own', () => {
    const next = toggleSitePermission(start, 'mcp', 'entries:delete', false)

    expect(next.site).toEqual(['entries:read', 'entries:delete'])
    expect(next.mcp).toEqual(['entries:read'])
  })

  test('ticking twice does not duplicate', () => {
    const next = toggleSitePermission(start, 'site', 'entries:read', true)
    expect(next.site.filter((each) => each === 'entries:read')).toHaveLength(1)
  })

  test('the input is never mutated', () => {
    toggleSitePermission(start, 'site', 'entries:delete', false)
    expect(start.mcp).toEqual(['entries:read', 'entries:delete'])
  })
})
