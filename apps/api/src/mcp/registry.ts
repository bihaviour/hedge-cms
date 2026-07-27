import { type InstancePermission, type McpScope, type Role, roleAtLeast } from '@hedge/core'
import { z } from 'zod'
import type { SiteRow } from '../db/schema'
import type { Actor, Bindings } from '../env'
import { type McpTool, McpToolError } from '../lib/mcp'

/**
 * The tool registry behind the MCP endpoint.
 *
 * Every tool declares two independent things, and both are enforced on every call:
 *
 * - a **scope**, which is what the operator delegated to this client at the consent screen
 * - a **role**, which is what the operator themselves actually holds
 *
 * Neither implies the other, and the narrower one always wins. Granting `users:write` to a client
 * approved by an editor does not let it manage users, and an owner using a client that only asked
 * for `entries:read` still cannot publish through it. That is what makes the surface differ per
 * user without any per-user configuration: the same client, approved by two different people, can
 * do two different things.
 *
 * An owner needs no special case anywhere in here. The built-in owner role carries every instance
 * permission, and `siteRoleFor` resolves anyone with `sites:access_all` to site admin on *every*
 * site — so an owner passes both halves of every check by construction rather than by exemption.
 */

/** What a tool requires: a delegated scope, plus a role at one of the two authorisation levels. */
export interface ToolAccess {
  scope: McpScope
  /**
   * Minimum role on the **active site**. For anything that belongs to one tenant: content, media,
   * newsletters, that site's keys.
   */
  site?: Role
  /**
   * The **instance** permission required. For anything that is not one site's business — managing
   * users, or creating and destroying sites. Matched against the operator's own role permissions,
   * the same set `requirePermission` checks on the REST side.
   */
  instance?: InstancePermission
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
  /** Their role on the active site. Never null: the endpoint refuses a caller with none. */
  siteRole: Role
}

export interface ToolResult {
  /** The machine-readable result, returned as `structuredContent`. */
  structured: unknown
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

/** JSON Schema as MCP clients expect it — the input side of the zod schema, sans `$schema`. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  return rest
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
  const { scope, site, instance } = definition.access

  if (!granted.has(scope)) {
    throw new McpToolError(`This client was not granted the "${scope}" scope`)
  }

  if (instance && !ctx.instancePermissions.includes(instance)) {
    throw new McpToolError(
      `"${definition.name}" requires the "${instance}" permission on this deployment, which your role does not carry`,
    )
  }

  if (site && !roleAtLeast(ctx.siteRole, site)) {
    throw new McpToolError(
      `"${definition.name}" requires ${site} access to the "${ctx.site.slug}" site — you are ${ctx.siteRole}`,
    )
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
 * Role, by contrast, is never used to hide anything: it can change between two calls with the same
 * token, and the tool that fails on it names the role that was missing.
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
    hidden: !granted.has(definition.access.scope),
    handler: async (args: Record<string, unknown>) => {
      authorize(definition, ctx, granted)
      const input = parseArgs(definition.args, args)
      const { structured, text } = await definition.handler(input, ctx)
      return { content: [{ type: 'text' as const, text }], structuredContent: structured }
    },
  }))
}
