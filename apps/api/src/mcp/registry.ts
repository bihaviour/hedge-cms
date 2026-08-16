import {
  hasSitePermission,
  type InstancePermission,
  type McpScope,
  type SitePermission,
} from '@hedge/core'
import { z } from 'zod'
import type { SiteRow } from '../db/schema'
import type { Actor, Bindings } from '../env'
import { ApiError } from '../lib/errors'
import { type McpTool, McpToolError } from '../lib/mcp'
import { compactSchema } from './schema-compact'

/**
 * The tool registry behind the MCP endpoint.
 *
 * Every tool declares two independent things, and both are enforced on every call:
 *
 * - a **scope**, which is what the operator delegated to this client at the consent screen
 * - a **permission**, which is what the operator's own role delegates to MCP at all
 *
 * Neither implies the other, and the narrower one always wins. Granting `users:write` to a client
 * approved by an editor does not let it manage users, and an owner using a client that only asked
 * for `entries:read` still cannot publish through it. That is what makes the surface differ per
 * user without any per-user configuration: the same client, approved by two different people, can
 * do two different things.
 *
 * Since #151 the second half is a **set, and a delegated one**: `ctx.sitePermissions` is the `mcp`
 * column of the approving user's role, which they may narrow below what they can do themselves.
 * "I may delete entries; nothing acting as me may" is one edit on one role, and it holds for every
 * client they ever approve — where the destructive grant (#145) is per client and per consent.
 * Effective authority is `role.mcp ∩ token scopes ∩ destructive grant`, and all three are checked.
 *
 * An owner needs no special case anywhere in here. The built-in owner role carries every instance
 * permission, and `sitePermissionsFor` resolves anyone with `sites:access_all` to every site
 * permission on *every* site — so an owner passes both halves by construction, not by exemption.
 */

/** What a tool requires: a delegated scope, plus authority at one of the two levels. */
export interface ToolAccess {
  scope: McpScope
  /**
   * What the tool does on the **active site**, checked against the approving user's **mcp** column
   * — not their site column (#151). That is the whole of the third column: a person who may delete
   * an entry in the admin can withhold the delete from every agent acting as them, and does it once
   * on their role rather than per client.
   *
   * Pick the same permission the REST route that does this thing asks for. A tool whose gate is
   * looser than its route is a hole, and the vocabulary is now fine enough that "looser" is
   * checkable rather than a judgement.
   *
   * A **list** means every one of them, for the merged tools: `write_collection` creates *or*
   * updates depending on what it finds, and a caller cannot promise which half it will use.
   */
  permission?: SitePermission | readonly SitePermission[]
  /**
   * The **instance** permission required. For anything that is not one site's business — managing
   * users, or creating and destroying sites. Matched against the operator's own role permissions,
   * the same set `requirePermission` checks on the REST side.
   */
  instance?: InstancePermission
  /**
   * Opts a tool into the destructive grant (#145) when it is not one of the ten the annotation
   * already catches.
   *
   * The gate derives from `annotations.destructiveHint` first, so a delete added later is covered
   * without anyone remembering — the same shape as "a new management route must be in one of the
   * two prefix lists". This field is for the tools that need the grant but must **not** claim that
   * annotation: `upload_media` is purely additive and would be lying to every client that reads
   * `destructiveHint` to decide whether to ask a human.
   */
  destructive?: true
}

/** What a tool handler is given. Resolved once per request, before any tool runs. */
export interface McpContext {
  env: Bindings
  /** The site named by `X-Hedge-Site`, `?site=`, or the deployment's only site. */
  site: SiteRow
  /** The user the token acts for. Always `kind: 'user'`, `via: 'oauth'`. */
  actor: Actor
  /** The instance permissions their role carries — what user- and site-management tools check. */
  instancePermissions: string[]
  /**
   * What this client may do on the active site — the **mcp** column of the approving user's role,
   * never their site column. Never null: the endpoint refuses a caller with no access at all.
   */
  sitePermissions: readonly SitePermission[]
  /**
   * Whether the operator let this client delete and overwrite (#145). **True when they never said
   * otherwise** — every consent given before the grant existed has no row, and must keep working
   * exactly as it did.
   */
  destructive: boolean
}

/** Whether a tool needs the destructive grant: the annotation, or an explicit opt-in. */
export function isDestructive(definition: ToolDefinition): boolean {
  return definition.access.destructive === true || definition.annotations?.destructiveHint === true
}

export interface ToolResult {
  /**
   * The machine-readable result, returned as `structuredContent`.
   *
   * **A record, never a bare array** — the MCP spec says `structuredContent` is a JSON object, and
   * a conforming client rejects the whole response before the model sees it rather than warning
   * about it, so a tool that returns an array is not degraded but unusable (#114). The type is what
   * enforces that: an array has no string index signature, so returning one is a compile error
   * instead of something only a real client discovers. Wrap a list as `{ data }` — the shape the
   * paginated tools already return, minus `nextCursor`, so nothing has to special-case which list
   * it is holding.
   */
  structured: Record<string, unknown>
  /** A short human/model-readable summary. Keep it scannable — it lands in a context window. */
  text: string
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string
  title: string
  description: string
  /** Reuses a `@hedge/core` schema wherever one exists, so MCP can never accept what REST rejects. */
  args: S
  access: ToolAccess
  annotations?: Record<string, unknown>
  handler: (input: z.infer<S>, ctx: McpContext) => Promise<ToolResult>
}

/** Preserves the argument type through the array literal in each tool module. */
export function defineTool<S extends z.ZodType>(definition: ToolDefinition<S>): ToolDefinition {
  return definition as ToolDefinition
}

/**
 * JSON Schema as MCP clients expect it — the input side of the zod schema, sans `$schema`, and
 * compacted.
 *
 * The compaction is not cosmetic: `tools/list` is fetched before a client can do anything and all
 * of it lands in a model's context window, so a schema that restates itself is a tax on every
 * session. `compactSchema` factors out what repeats and changes nothing about what is accepted —
 * `schema-compact.test.ts` checks that by expanding every tool's schema back and comparing.
 */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  return compactSchema(rest)
}

function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.infer<S> {
  const result = schema.safeParse(args)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '_'}: ${issue.message}`)
      .join('; ')
    throw new McpToolError(`Invalid arguments — ${detail}`)
  }
  return result.data
}

/**
 * The gate every tool call passes through. Scope first — it is the cheaper check and the more
 * common refusal — then whichever role level the tool declared.
 */
function authorize(definition: ToolDefinition, ctx: McpContext, granted: Set<string>) {
  const { scope, permission, instance } = definition.access

  if (!granted.has(scope)) {
    throw new McpToolError(`This client was not granted the "${scope}" scope`)
  }

  // Checked after the scope and before either role, because it is the operator's own decision about
  // this client rather than anything the client presented — and unlike a role it cannot change
  // between two calls on one token without the operator revisiting the consent.
  if (!ctx.destructive && isDestructive(definition)) {
    throw new McpToolError(
      `"${definition.name}" deletes or overwrites, and you did not allow this client to do that. ` +
        'Approve it again from Settings → Account to change that.',
    )
  }

  if (instance && !ctx.instancePermissions.includes(instance)) {
    throw new McpToolError(
      `"${definition.name}" requires the "${instance}" permission on this deployment, which your role does not carry`,
    )
  }

  if (permission) {
    const required = typeof permission === 'string' ? [permission] : permission
    const missing = required.filter((each) => !hasSitePermission(ctx.sitePermissions, each))
    if (missing.length > 0) {
      throw new McpToolError(
        `"${definition.name}" needs ${missing.join(' and ')} on the "${ctx.site.slug}" site. ` +
          'Your role either does not carry that, or does not delegate it to an MCP client.',
      )
    }
  }
}

/**
 * Turns the definitions into this caller's tools, wiring the authorisation gate in front of each
 * handler.
 *
 * What is *advertised* is filtered by scope; what is *callable* is not. A scope is fixed for the
 * life of the token, so listing a tool the client can never use would only invite it to try — but a
 * client that calls one anyway gets the real reason ("not granted the `users:write` scope"), which
 * an operator can act on, instead of an "unknown tool" that reads as though the CMS cannot do it.
 *
 * A **permission** is never used to hide anything, and that stayed true when the site matrix
 * replaced the rank (#155). It is part of a role, and a role can change between two calls on one
 * token — `tools.listChanged` is false here, so a list narrowed by something mutable would be a
 * list the client never learns to refetch. The tool that fails names the permission that was
 * missing, which an operator can act on.
 */
export function buildTools(
  definitions: ToolDefinition[],
  ctx: McpContext,
  grantedScopes: string[],
): McpTool[] {
  const granted = new Set(grantedScopes)

  return definitions.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: inputSchema(definition.args),
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    // Hidden on the same grounds a missing scope hides a tool: both are fixed for the life of the
    // consent, so advertising one the client can never use only invites it to try. Calling it
    // anyway still reports the real reason — `hidden` keeps a tool out of `tools/list`, not out of
    // dispatch — which an operator can act on, unlike "unknown tool".
    hidden:
      !granted.has(definition.access.scope) || (!ctx.destructive && isDestructive(definition)),
    handler: async (args: Record<string, unknown>) => {
      authorize(definition, ctx, granted)
      const input = parseArgs(definition.args, args)
      try {
        const { structured, text } = await definition.handler(input, ctx)
        return { content: [{ type: 'text' as const, text }], structuredContent: structured }
      } catch (error) {
        // Every tool delegates to the same `lib/` services the REST routes use, and those raise
        // `ApiError` — "no such entry", "that slug is taken", "the file is too large". Only
        // `McpToolError` is reported as a tool *result*, so without this translation a routine 404
        // leaves the JSON-RPC layer entirely and the client gets a protocol failure with no id in
        // it: a model reads that as "the CMS is broken" rather than "fix the slug and retry".
        if (error instanceof ApiError) throw new McpToolError(error.message)
        throw error
      }
    },
  }))
}
