import { describe, expect, test } from 'bun:test'
import { ALL_TOOLS } from './index'
import { isDestructive } from './registry'

/**
 * Which tools the destructive grant covers, and — more importantly — that the answer is *derived*
 * rather than maintained (#145).
 *
 * The gate reads `annotations.destructiveHint`, so a delete added next year is behind the grant
 * without anyone remembering to put it there. That is the same shape as "a new management route
 * must be in one of the two prefix lists", and it is the half of this feature that cannot be
 * checked by using the product: a tool that quietly escaped the grant would work perfectly.
 */

const EXPECTED = [
  // The ten the annotation catches on its own.
  'delete_api_key',
  'delete_collection',
  'delete_entry',
  'delete_media',
  'delete_newsletter',
  'delete_newsletter_template',
  'delete_site',
  'delete_subscriber',
  'delete_user',
  'revoke_site_access',
  // The two that opt in explicitly, because neither may claim `destructiveHint` honestly.
  'update_media',
  'upload_media',
].sort()

describe('the destructive grant', () => {
  test('covers exactly the tools it is meant to', () => {
    const covered = ALL_TOOLS.filter(isDestructive)
      .map((tool) => tool.name)
      .sort()

    expect(covered).toEqual(EXPECTED)
  })

  test('every annotated tool is covered without declaring anything', () => {
    // The derivation itself. A tool marked destructive in the protocol sense can never be outside
    // the grant, whatever its `access` block says.
    for (const tool of ALL_TOOLS) {
      if (tool.annotations?.destructiveHint === true) {
        expect(isDestructive(tool)).toBe(true)
        expect(tool.access.destructive).toBeUndefined()
      }
    }
  })

  test('the two opt-ins do not claim destructiveHint', () => {
    // `destructiveHint` is what a client reads to decide whether to ask a human. An upload destroys
    // nothing, and prompting before every caption fix is the wrong trade for a backlog tool — so
    // both stay out of the annotation and into the grant by the explicit route.
    for (const name of ['update_media', 'upload_media']) {
      const tool = ALL_TOOLS.find((one) => one.name === name)
      expect(tool?.access.destructive).toBe(true)
      expect(tool?.annotations?.destructiveHint).toBeUndefined()
    }
  })

  test('no read-only tool is caught by it', () => {
    for (const tool of ALL_TOOLS) {
      if (tool.annotations?.readOnlyHint === true) expect(isDestructive(tool)).toBe(false)
    }
  })
})
