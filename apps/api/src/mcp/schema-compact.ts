/**
 * Shrinking a tool's JSON Schema without changing what it accepts.
 *
 * Every MCP client fetches `tools/list` before it can do anything, and the whole of it lands in a
 * model's context window. On this deployment that was ~13,000 tokens for 55 tools, and 37% of it was
 * one schema: the 13-kind field union, inlined three times (twice for collections, once as a site's
 * custom fields). Each of its branches restates the same five base properties — `name` with its
 * snake_case pattern, `label`, `description`, `required`, `localized` — so most of those bytes are
 * the union repeating itself.
 *
 * Two passes, both of which produce a schema that validates exactly the same documents:
 *
 * 1. **Factor a union's shared head.** Properties every branch declares identically move to one
 *    `$defs` entry, and each branch becomes `allOf: [{$ref}, {…what is left}]`.
 * 2. **Hoist whatever is still repeated.** Any subschema appearing more than once, where a `$ref`
 *    is shorter than the thing it replaces.
 *
 * `expand` is the inverse, and it exists for the test rather than for the runtime: a compaction that
 * expands back to the schema it started from cannot have changed the contract, and that is a
 * property worth checking on every tool rather than a claim to make in a comment.
 *
 * `zod`'s own `reused: 'ref'` is not a substitute — measured, it saves ~10%, because it dedupes by
 * schema *instance* and `baseField.extend()` produces a fresh one per branch.
 */

type Json = Record<string, unknown>

function isNode(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A `$ref` costs about this much, so hoisting anything smaller makes the payload bigger. */
const REF_COST = 24

function mapChildren(node: Json, fn: (value: unknown) => unknown): Json {
  const out: Json = {}
  for (const [key, value] of Object.entries(node)) out[key] = fn(value)
  return out
}

/**
 * Pass 1 — factor the properties every branch of a union has in common.
 *
 * Skipped when any branch closes itself with `additionalProperties: false`: `allOf` is an
 * intersection of *independent* assertions, so a closed branch would reject the very properties the
 * `$ref` beside it contributes. Nothing in `@hedge/core` is closed today; the guard is here because
 * a `.strict()` added later would otherwise turn a size optimisation into a validation change.
 */
function factorUnionHeads(root: Json, defs: Json): Json {
  let n = 0

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!isNode(node)) return node

    const out = mapChildren(node, walk)

    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const branches = out[keyword]
      if (!Array.isArray(branches) || branches.length < 3) continue

      const objects = branches.filter(
        (branch): branch is Json =>
          isNode(branch) &&
          branch.type === 'object' &&
          isNode(branch.properties) &&
          branch.additionalProperties === undefined,
      )
      if (objects.length !== branches.length) continue

      const first = objects[0]!.properties as Json
      const shared: Json = {}
      for (const [name, schema] of Object.entries(first)) {
        const json = JSON.stringify(schema)
        if (json.length < 20) continue
        if (objects.every((branch) => JSON.stringify((branch.properties as Json)[name]) === json)) {
          shared[name] = schema
        }
      }
      if (Object.keys(shared).length < 2) continue

      const sharedRequired = ((objects[0]!.required as string[] | undefined) ?? []).filter(
        (name) =>
          name in shared &&
          objects.every((branch) => (branch.required as string[] | undefined)?.includes(name)),
      )

      const defName = `shared${n === 0 ? '' : n}`
      n += 1
      defs[defName] = {
        type: 'object',
        properties: shared,
        ...(sharedRequired.length > 0 ? { required: sharedRequired } : {}),
      }

      out[keyword] = objects.map((branch) => {
        const rest: Json = {}
        for (const [name, schema] of Object.entries(branch.properties as Json)) {
          if (!(name in shared)) rest[name] = schema
        }
        const required = ((branch.required as string[] | undefined) ?? []).filter(
          (name) => !sharedRequired.includes(name),
        )
        const { properties: _p, required: _r, type: _t, ...extra } = branch
        return {
          allOf: [
            { $ref: `#/$defs/${defName}` },
            {
              type: 'object',
              properties: rest,
              ...(required.length > 0 ? { required } : {}),
              ...extra,
            },
          ],
        }
      })
    }

    return out
  }

  return walk(root) as Json
}

/** Pass 2 — hoist any subschema that still appears more than once and is worth a `$ref`. */
function hoistRepeats(root: Json, defs: Json): Json {
  let current = root
  let n = 0

  for (;;) {
    const counts = new Map<string, number>()
    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item)
        return
      }
      if (!isNode(node) || node === current) return
      for (const value of Object.values(node)) visit(value)
      if ('$ref' in node) return
      const json = JSON.stringify(node)
      if (json.length > REF_COST + 8) counts.set(json, (counts.get(json) ?? 0) + 1)
    }
    for (const [key, value] of Object.entries(current)) {
      if (key !== '$defs') visit(value)
    }

    let best: { json: string; saving: number } | null = null
    for (const [json, count] of counts) {
      if (count < 2) continue
      // The definition is written once and every use shrinks to a `$ref`.
      const saving = count * (json.length - REF_COST) - json.length
      if (saving > 0 && (!best || saving > best.saving)) best = { json, saving }
    }
    if (!best) return current

    const defName = `part${n === 0 ? '' : n}`
    n += 1
    defs[defName] = JSON.parse(best.json)

    const replace = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(replace)
      if (!isNode(node)) return node
      if (JSON.stringify(node) === best.json) return { $ref: `#/$defs/${defName}` }
      return mapChildren(node, replace)
    }
    current = mapChildren(current, (value) => replace(value))
  }
}

/**
 * The compact form of a tool's JSON Schema. Same contract, fewer bytes.
 *
 * `$defs` and `$ref` are ordinary draft 2020-12 — zod emits both itself for a recursive schema — so
 * a client that could read the schema before can read this one.
 */
export function compactSchema(schema: Json): Json {
  const defs: Json = { ...((schema.$defs as Json | undefined) ?? {}) }
  const { $defs: _existing, ...body } = schema

  const factored = factorUnionHeads(body, defs)
  const hoisted = hoistRepeats(factored, defs)

  return Object.keys(defs).length > 0 ? { ...hoisted, $defs: defs } : hoisted
}

/**
 * Inlines every `$ref` back into place — the inverse of `compactSchema`, for its test.
 *
 * An `allOf` of object schemas produced by pass 1 is merged back into the single object it came
 * from, which is what lets a round trip be compared against the original by value.
 */
export function expandSchema(schema: Json): Json {
  const defs = (schema.$defs as Json | undefined) ?? {}

  const resolve = (ref: string): Json => {
    const name = ref.replace('#/$defs/', '')
    const target = defs[name]
    if (!isNode(target)) throw new Error(`Unresolvable $ref: ${ref}`)
    return target
  }

  const inline = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(inline)
    if (!isNode(node)) return node

    if (typeof node.$ref === 'string') return inline(resolve(node.$ref))

    const out = mapChildren(node, inline)

    // Undo pass 1: `allOf` of object schemas becomes the object they were split from.
    if (Array.isArray(out.allOf) && Object.keys(out).length === 1) {
      const parts = out.allOf as unknown[]
      if (parts.every((part) => isNode(part) && part.type === 'object')) {
        const properties: Json = {}
        const required: string[] = []
        let extra: Json = {}
        for (const part of parts as Json[]) {
          Object.assign(properties, (part.properties as Json | undefined) ?? {})
          required.push(...((part.required as string[] | undefined) ?? []))
          const { properties: _p, required: _r, type: _t, ...rest } = part
          extra = { ...extra, ...rest }
        }
        return {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
          ...extra,
        }
      }
    }

    return out
  }

  const { $defs: _defs, ...body } = schema
  return inline(body) as Json
}
