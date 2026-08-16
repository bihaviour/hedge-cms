import { HEDGE_VERSION } from '@hedge/core'
import { type Context, Hono } from 'hono'
import { getCmsAuth } from '../auth/cms'
import type { AppEnv } from '../env'
import { sitePermissionsFor, userRole } from '../lib/auth'
import { handleRpcPayload, type McpServer } from '../lib/mcp'
import { destructiveGrantFor } from '../lib/mcp-grants'
import { permissionsForRole } from '../lib/roles'
import { requireSite } from '../lib/site'
import { ALL_TOOLS, buildTools, type McpContext } from '../mcp'

const app = new Hono<AppEnv>()

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
 * for the user who approved it, so their roles still decide what it can reach; the token's scopes
 * only ever narrow that further. See `mcp/registry.ts` for how the two combine.
 */
app.post('/', async (c) => {
  const token = await getCmsAuth(c.env).api.getMcpSession({ headers: c.req.raw.headers })
  if (!token) return challenge(c, 'Unauthorized: Authentication required')

  const site = requireSite(c)
  const role = await userRole(c.env, token.userId)
  if (!role) return challenge(c, 'Unauthorized: the account behind this token no longer exists')

  const permissions = await permissionsForRole(c.env, role)
  const scopes = token.scopes.split(/[\s,]+/).filter(Boolean)
  const actor = {
    kind: 'user' as const,
    via: 'oauth' as const,
    id: token.userId,
    role,
    permissions,
    scopes,
    siteId: null,
  }
  c.set('actor', actor)

  // The **mcp** column, not the site one: what this person delegates to an agent acting as them
  // (#151). Resolved per request like the destructive grant, so narrowing a role lands on the next
  // call rather than on the next consent.
  const sitePermissions = await sitePermissionsFor(c.env, actor, site.id, 'mcp')
  if (!sitePermissions) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `You do not have access to the "${site.slug}" site` },
      },
      403,
    )
  }

  // What the operator allowed this client beyond the scopes it asked for. Unrecorded means granted,
  // so a consent given before #145 keeps behaving exactly as it did.
  const destructive = await destructiveGrantFor(c.env, token.userId, token.clientId)

  const ctx: McpContext = {
    env: c.env,
    site,
    actor,
    instancePermissions: permissions,
    sitePermissions,
    destructive,
  }
  const tools = buildTools(ALL_TOOLS, ctx, scopes)

  const server: McpServer = {
    name: 'hedge',
    version: HEDGE_VERSION,
    instructions:
      'Manage a Hedge CMS site: its content model (collections and their typed fields), its ' +
      'entries, media, newsletters and subscribers, and — for an instance admin — its sites, ' +
      'users and API keys. Every tool acts on the active site. Read a collection before writing ' +
      'an entry into it: entry `data` is validated against that collection’s fields. Tools you ' +
      'cannot see were not granted to this client at consent; tools that refuse at call time are ' +
      'telling you the approving user’s own role is not high enough.',
    tools,
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
