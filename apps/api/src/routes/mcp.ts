import {
  type CreateCollectionInput,
  createCollectionSchema,
  MCP_SCOPES,
  roleAtLeast,
  slugSchema,
  type UpdateCollectionInput,
  updateCollectionSchema,
} from '@hedge/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { getCmsAuth } from '../auth/cms'
import type { AppEnv, Bindings } from '../env'
import { currentSiteRole, userRole } from '../lib/auth'
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  updateCollection,
} from '../lib/collections'
import { handleRpcPayload, type McpServer, type McpTool, McpToolError } from '../lib/mcp'
import { requireSite } from '../lib/site'

const app = new Hono<AppEnv>()

// Tool argument schemas. `slug` identifies the collection for the single-item tools; create and
// update reuse the very schemas the REST API validates against, so the MCP surface can never
// accept anything the HTTP API would reject.
const slugArg = z.object({ slug: slugSchema })
const listArgs = z.object({})
const getArgs = slugArg
const createArgs = createCollectionSchema
const updateArgs = slugArg.extend(updateCollectionSchema.shape)
const deleteArgs = slugArg

/** JSON Schema as MCP clients expect it — the input side of the zod schema, sans `$schema`. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  return rest
}

function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const result = schema.safeParse(args)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '_'}: ${issue.message}`)
      .join('; ')
    throw new McpToolError(`Invalid arguments — ${detail}`)
  }
  return result.data
}

function ok(structured: unknown, text: string) {
  return { content: [{ type: 'text' as const, text }], structuredContent: structured }
}

/**
 * Builds the collection tools for one request. The closures carry the resolved site and the
 * authorisation checks, so a tool call is always scoped to the caller's tenant and permissions.
 *
 * Reads need the `content:read` scope (a plain user always passes); writes are an admin power, so
 * they require the `collections:write` scope on an API key or an admin role for a signed-in user.
 */
function collectionTools(
  env: Bindings,
  siteId: string,
  authorize: { read: () => void; write: () => Promise<void> },
): McpTool[] {
  return [
    {
      name: 'list_collections',
      title: 'List collections',
      description: 'List every collection defined on the current site.',
      inputSchema: inputSchema(listArgs),
      annotations: { readOnlyHint: true },
      handler: async () => {
        authorize.read()
        const data = await listCollections(env, siteId)
        const summary = data.length
          ? data.map((col) => `- ${col.slug} (${col.name}, ${col.fields.length} fields)`).join('\n')
          : 'No collections yet.'
        return ok(data, summary)
      },
    },
    {
      name: 'get_collection',
      title: 'Get collection',
      description: 'Fetch one collection and its full field definitions by slug.',
      inputSchema: inputSchema(getArgs),
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        authorize.read()
        const { slug } = parseArgs(getArgs, args)
        const data = await getCollection(env, siteId, slug)
        return ok(data, JSON.stringify(data, null, 2))
      },
    },
    {
      name: 'create_collection',
      title: 'Create collection',
      description:
        'Create a new collection. `slug` must be lowercase kebab-case. Omit `fields` to start ' +
        'with a default title + body pair. `kind` is "multiple" (many entries) or "single" (one).',
      inputSchema: inputSchema(createArgs),
      handler: async (args) => {
        await authorize.write()
        const input = parseArgs(createArgs, args) as CreateCollectionInput
        const data = await createCollection(env, siteId, input)
        return ok(data, `Created collection "${data.slug}".`)
      },
    },
    {
      name: 'update_collection',
      title: 'Update collection',
      description:
        'Update a collection by slug. Only the provided keys change; `fields`, when given, ' +
        'replaces the whole field list.',
      inputSchema: inputSchema(updateArgs),
      handler: async (args) => {
        await authorize.write()
        const { slug, ...input } = parseArgs(updateArgs, args)
        const data = await updateCollection(env, siteId, slug, input as UpdateCollectionInput)
        return ok(data, `Updated collection "${data.slug}".`)
      },
    },
    {
      name: 'delete_collection',
      title: 'Delete collection',
      description: 'Delete a collection by slug. Its entries are removed along with it.',
      inputSchema: inputSchema(deleteArgs),
      annotations: { destructiveHint: true },
      handler: async (args) => {
        await authorize.write()
        const { slug } = parseArgs(deleteArgs, args)
        await deleteCollection(env, siteId, slug)
        return ok({ slug, deleted: true }, `Deleted collection "${slug}".`)
      },
    },
  ]
}

/**
 * An unauthenticated MCP request is answered with the challenge RFC 9728 defines, pointing at the
 * metadata document that tells a client where to get a token. That pointer is the whole reason a
 * client can connect with nothing but a URL: it discovers the authorization server, registers
 * itself, and sends the operator through a browser sign-in.
 */
function challenge(c: Context<AppEnv>, message: string) {
  const value = `Bearer resource_metadata="${c.env.PUBLIC_URL}/.well-known/oauth-protected-resource"`
  c.header('WWW-Authenticate', value)
  c.header('Access-Control-Expose-Headers', 'WWW-Authenticate')
  return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }, 401)
}

/**
 * The MCP endpoint.
 *
 * Callers authenticate with an OAuth 2.1 access token — not with a delivery API key, which is the
 * credential a public website holds and has no business rewriting content models. The token acts
 * for the user who approved it, so their site role still decides what it can reach; the token's
 * scopes only ever narrow that further.
 */
app.post('/', async (c) => {
  const token = await getCmsAuth(c.env).api.getMcpSession({ headers: c.req.raw.headers })
  if (!token) return challenge(c, 'Unauthorized: Authentication required')

  const site = requireSite(c)
  const role = await userRole(c.env, token.userId)
  if (!role) return challenge(c, 'Unauthorized: the account behind this token no longer exists')

  const scopes = token.scopes.split(/[\s,]+/).filter(Boolean)
  c.set('actor', {
    kind: 'user',
    via: 'oauth',
    id: token.userId,
    role,
    scopes,
    siteId: null,
  })

  const siteRole = await currentSiteRole(c)
  if (!siteRole) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `You do not have access to the "${site.slug}" site` },
      },
      403,
    )
  }

  const read = () => {
    if (!scopes.includes(MCP_SCOPES.collectionsRead)) {
      throw new McpToolError(
        `This client was not granted the "${MCP_SCOPES.collectionsRead}" scope`,
      )
    }
  }
  const write = async () => {
    if (!scopes.includes(MCP_SCOPES.collectionsWrite)) {
      throw new McpToolError(
        `This client was not granted the "${MCP_SCOPES.collectionsWrite}" scope`,
      )
    }
    // The scope is what the operator delegated; the role is what they actually have. Both apply.
    const role = await currentSiteRole(c)
    if (!role || !roleAtLeast(role, 'admin')) {
      throw new McpToolError(`Requires admin access to the "${site.slug}" site`)
    }
  }

  const server: McpServer = {
    name: 'hedge-collections',
    version: '0.0.1',
    instructions:
      'Manage the content collections of the current Hedge site. A collection is a content type ' +
      'with a slug, a name and a list of typed fields.',
    tools: collectionTools(c.env, site.id, { read, write }),
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      400,
    )
  }

  const responses = await handleRpcPayload(server, payload)
  // A batch of only notifications produces nothing to send.
  if (responses.length === 0) return c.body(null, 202)
  return c.json(Array.isArray(payload) ? responses : responses[0]!)
})

// The transport is stateless and request/response only — there is no server-initiated stream to
// open with GET, and no session to end with DELETE.
app.on(['GET', 'DELETE'], '/', (c) =>
  c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } }, 405),
)

export default app
