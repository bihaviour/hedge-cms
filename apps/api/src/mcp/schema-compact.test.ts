import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ALL_TOOLS } from './index'
import { compactSchema, expandSchema } from './schema-compact'

/**
 * The compaction's whole claim is that it changes the size of a tool's schema and nothing else, and
 * the way to check that is not to read it: every tool's schema is compacted, expanded again, and
 * compared to what it started as. A pass that dropped a property, a `required` entry or a `const`
 * would fail here on the tool that carried it rather than in a client six months later.
 */

type Json = Record<string, unknown>

const schemaFor = (tool: (typeof ALL_TOOLS)[number]): Json => {
  const { $schema, ...rest } = z.toJSONSchema(tool.args, { io: 'input' }) as Json
  return rest
}

describe('compactSchema', () => {
  test.each(ALL_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s round-trips unchanged',
    (_name, tool) => {
      const original = schemaFor(tool)
      expect(expandSchema(compactSchema(original))).toEqual(original)
    },
  )

  test('every $ref it emits resolves', () => {
    for (const tool of ALL_TOOLS) {
      const compact = compactSchema(schemaFor(tool))
      const defs = (compact.$defs as Json | undefined) ?? {}
      const refs = JSON.stringify(compact).match(/"#\/\$defs\/[^"]+"/g) ?? []
      for (const ref of refs) {
        expect(defs).toHaveProperty(ref.replaceAll('"', '').replace('#/$defs/', ''))
      }
    }
  })

  test('factors the head a union’s branches share', () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), name: z.string().min(1).max(64), extra: z.string() }),
      z.object({ kind: z.literal('b'), name: z.string().min(1).max(64), count: z.number() }),
      z.object({ kind: z.literal('c'), name: z.string().min(1).max(64) }),
    ])
    const { $schema, ...original } = z.toJSONSchema(union, { io: 'input' }) as Json
    const compact = compactSchema(original)

    // `name` is identical in all three, so it moves; `kind` differs by `const` and stays put.
    expect(JSON.stringify(compact.$defs)).toContain('maxLength')
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length)
    expect(expandSchema(compact)).toEqual(original)
  })

  test('leaves a union alone when a branch closes itself', () => {
    // `allOf` is an intersection of independent assertions, so a closed branch would reject the
    // properties the `$ref` beside it contributes — the one case where factoring would change
    // what validates.
    const closed = z.union([
      z.strictObject({ name: z.string().min(1).max(64), a: z.string() }),
      z.strictObject({ name: z.string().min(1).max(64), b: z.string() }),
      z.strictObject({ name: z.string().min(1).max(64), c: z.string() }),
    ])
    const { $schema, ...original } = z.toJSONSchema(closed, { io: 'input' }) as Json
    const compact = compactSchema(original)

    expect(JSON.stringify(compact)).not.toContain('allOf')
    expect(expandSchema(compact)).toEqual(original)
  })

  test('does not hoist something smaller than the $ref replacing it', () => {
    const tiny = z.object({ a: z.string(), b: z.string(), c: z.string() })
    const { $schema, ...original } = z.toJSONSchema(tiny, { io: 'input' }) as Json
    expect(compactSchema(original)).toEqual(original)
  })
})

/**
 * The budget. `tools/list` is fetched before a client can do anything and lands whole in a model's
 * context, so its size is a feature with a number on it — this is what stops the next tool, or the
 * next schema inlined three times, from quietly putting it back.
 *
 * Raise it deliberately, in a commit that says why, or find what repeated.
 */
const PAYLOAD_BUDGET = 42_000

const advertise = (tools: typeof ALL_TOOLS) =>
  JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: compactSchema(schemaFor(tool)),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  ).length

test('the advertised tool surface stays inside its budget', () => {
  expect(advertise(ALL_TOOLS)).toBeLessThan(PAYLOAD_BUDGET)
})

/**
 * The budget above is the worst case — every scope granted. `buildTools` hides what the client was
 * not granted, so the scopes an operator approves are the other half of this number and the half
 * they control. Pinned because it is the argument the consent screen makes: approving narrowly is
 * not only safer, it is what makes the surface cheap enough for a model to reason about.
 */
test('a narrowly-granted client is advertised a fraction of it', () => {
  const authoring = ALL_TOOLS.filter((tool) =>
    ['entries:read', 'entries:write', 'media:read', 'media:write', 'collections:read'].includes(
      tool.access.scope,
    ),
  )

  expect(advertise(authoring)).toBeLessThan(advertise(ALL_TOOLS) / 2)
})
