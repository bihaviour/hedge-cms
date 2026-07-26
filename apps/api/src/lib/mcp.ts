/**
 * A minimal Model Context Protocol server over the Streamable HTTP transport, small enough to run
 * inside the Worker with no SDK. It speaks JSON-RPC 2.0 and implements the handful of methods an
 * MCP client needs to discover and call tools: `initialize`, `tools/list`, `tools/call` and
 * `ping`. Notifications (a message with no `id`) are accepted and produce no reply.
 *
 * The dispatch here is deliberately transport-agnostic and free of any Hono or D1 dependency, so
 * the collection tools can be exercised in isolation. See `routes/mcp.ts` for the wiring.
 */

export const LATEST_PROTOCOL_VERSION = '2025-06-18'
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

// Standard JSON-RPC 2.0 error codes.
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

export interface McpTextContent {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpTextContent[]
  structuredContent?: unknown
  isError?: boolean
}

export interface McpTool {
  name: string
  title?: string
  description: string
  /** JSON Schema for the tool's arguments — an object schema. */
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  /**
   * Kept out of `tools/list` but still callable — the call then fails with whatever the handler
   * says. A client that cannot use a tool should not be shown it, but one that calls it anyway
   * deserves the real reason rather than "unknown tool", which reads as "this does not exist".
   */
  hidden?: boolean
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export interface McpServer {
  name: string
  version: string
  instructions?: string
  tools: McpTool[]
}

/** A tool handler may throw this to fail a `tools/call` with a clean, client-facing message. */
export class McpToolError extends Error {}

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function negotiateVersion(params: unknown): string {
  const requested =
    params && typeof params === 'object' ? (params as Record<string, unknown>).protocolVersion : ''
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION
}

async function callTool(server: McpServer, params: unknown): Promise<McpToolResult> {
  const p = (params ?? {}) as Record<string, unknown>
  const name = typeof p.name === 'string' ? p.name : ''
  const tool = server.tools.find((t) => t.name === name)
  if (!tool) throw new McpToolError(`Unknown tool "${name}"`)

  const args = (p.arguments ?? {}) as Record<string, unknown>
  return tool.handler(args)
}

/**
 * Handles a single JSON-RPC message. Returns the response to send, or `null` when the message is
 * a notification (no `id`) and therefore takes no reply.
 */
export async function handleRpcMessage(
  server: McpServer,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const isNotification = message.id === undefined || message.id === null
  const id = message.id ?? null

  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return isNotification ? null : failure(id, RPC_INVALID_REQUEST, 'Invalid JSON-RPC request')
  }

  switch (message.method) {
    case 'initialize':
      return success(id, {
        protocolVersion: negotiateVersion(message.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      })

    case 'tools/list':
      return success(id, {
        tools: server.tools
          .filter((t) => !t.hidden)
          .map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
      })

    case 'tools/call': {
      if (isNotification) return null
      try {
        return success(id, await callTool(server, message.params))
      } catch (err) {
        if (err instanceof McpToolError) {
          // Tool-level failures are reported in the result with `isError`, not as protocol errors,
          // so the model sees them and can react.
          return success(id, { content: [{ type: 'text', text: err.message }], isError: true })
        }
        throw err
      }
    }

    case 'ping':
      return success(id, {})

    // `notifications/initialized`, `notifications/cancelled`, and any other notification.
    default:
      if (message.method.startsWith('notifications/')) return null
      return isNotification
        ? null
        : failure(id, RPC_METHOD_NOT_FOUND, `Unknown method "${message.method}"`)
  }
}

/**
 * Handles a parsed request body, which may be a single message or a JSON-RPC batch. Returns the
 * array of responses (notifications contribute none) — an empty array means "reply 202 with no
 * body".
 */
export async function handleRpcPayload(
  server: McpServer,
  payload: unknown,
): Promise<JsonRpcResponse[]> {
  const messages = Array.isArray(payload) ? payload : [payload]
  const responses: JsonRpcResponse[] = []
  for (const message of messages) {
    const response = await handleRpcMessage(server, message as JsonRpcRequest)
    if (response) responses.push(response)
  }
  return responses
}
