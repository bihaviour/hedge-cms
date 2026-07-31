import { describe, expect, test } from 'bun:test'
import {
  approvalLevelForSiteRole,
  clearedLevels,
  type EntryVersionApproval,
  entryVersionSchema,
} from './entry-version'

const approval = (decision: 'approved' | 'rejected', level: 1 | 2 = 1): EntryVersionApproval => ({
  id: `apr_${decision}${level}`,
  versionId: 'ver_1',
  level,
  decision,
  userId: 'usr_1',
  userName: 'A',
  comment: null,
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('clearedLevels', () => {
  test('counts approvals in order', () => {
    expect(clearedLevels([])).toBe(0)
    expect(clearedLevels([approval('approved', 1)])).toBe(1)
    expect(clearedLevels([approval('approved', 1), approval('approved', 2)])).toBe(2)
  })

  /**
   * A rejection sends the whole version back to its author, so the levels are re-cleared from
   * scratch on the next submission. Without this a version rejected at level 2 would come back
   * already holding level 1 — an approval of content nobody has read since it changed.
   */
  test('a rejection resets everything cleared before it', () => {
    expect(clearedLevels([approval('approved', 1), approval('rejected', 2)])).toBe(0)
    expect(
      clearedLevels([approval('approved', 1), approval('rejected', 2), approval('approved', 1)]),
    ).toBe(1)
  })
})

describe('approvalLevelForSiteRole', () => {
  test('maps the site roles onto the two levels', () => {
    expect(approvalLevelForSiteRole('viewer')).toBe(0)
    expect(approvalLevelForSiteRole('editor')).toBe(1)
    expect(approvalLevelForSiteRole('admin')).toBe(2)
  })

  /**
   * An instance owner reaching a site through `sites:access_all` resolves to site admin and has no
   * `site_users` row at all, so this mapping — not a special case — is what gives them level 2.
   */
  test('an owner clears both levels', () => {
    expect(approvalLevelForSiteRole('owner')).toBe(2)
  })
})

describe('entryVersionSchema', () => {
  test('accepts a version with no metadata override', () => {
    const parsed = entryVersionSchema.parse({
      id: 'ver_1',
      entryId: 'ent_1',
      collectionSlug: 'posts',
      entrySlug: 'hello',
      locale: 'en',
      title: 'Added the interview section',
      data: { title: 'Hello' },
      metadata: null,
      status: 'draft',
      baseUpdatedAt: '2026-01-01T00:00:00.000Z',
      stale: false,
      createdBy: 'usr_1',
      createdByName: 'A',
      submittedAt: null,
      publishedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      approvals: [],
      requiredLevels: 2,
    })
    expect(parsed.metadata).toBeNull()
    expect(parsed.requiredLevels).toBe(2)
  })
})
