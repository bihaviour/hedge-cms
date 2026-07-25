import { describe, expect, test } from 'bun:test'
import {
  handleRpcMessage,
  handleRpcPayload,
  LATEST_PROTOCOL_VERSION,
  type McpServer,
  McpToolError,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
} from './mcp'

function makeServer(): McpServer {
  return {
    name: 'test-server',
    version: '1.2.3',
    instructions: 'do things',
    tools: [
      {
        name: 'echo',
        description: 'echoes its input',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        annotations: { readOnlyHint: true },
        handler: async (args) => ({
          content: [{ type: 'text', text: String(args.value) }],
          structuredContent: { value: args.value },
        }),
      },
      {
        name: 'boom',
        description: 'always fails',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          throw new McpToolError('nope')
        },
      },
    ],
  }
}

describe('handleRpcMessage', () => {
  test('initialize negotiates a supported version and advertises tools', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    })
    expect(res).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-server', version: '1.2.3' },
        instructions: 'do things',
      },
    })
  })

  test('initialize falls back to the latest version when the client asks for an unknown one', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    })
    expect((res as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION,
    )
  })

  test('tools/list returns every tool with its schema', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    const tools = (res as { result: { tools: Array<{ name: string }> } }).result.tools
    expect(tools.map((t) => t.name)).toEqual(['echo', 'boom'])
    expect(tools[0]).toMatchObject({
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    })
  })

  test('tools/call runs the handler and returns its result', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'hi' } },
    })
    expect(res).toMatchObject({
      id: 3,
      result: { content: [{ type: 'text', text: 'hi' }], structuredContent: { value: 'hi' } },
    })
  })

  test('a tool that throws McpToolError becomes an isError result, not a protocol error', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'boom', arguments: {} },
    })
    expect(res).toMatchObject({
      id: 4,
      result: { isError: true, content: [{ type: 'text', text: 'nope' }] },
    })
  })

  test('calling an unknown tool is an isError result', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'ghost', arguments: {} },
    })
    expect((res as { result: { isError: boolean } }).result.isError).toBe(true)
  })

  test('ping returns an empty result', async () => {
    const res = await handleRpcMessage(makeServer(), { jsonrpc: '2.0', id: 6, method: 'ping' })
    expect(res).toEqual({ jsonrpc: '2.0', id: 6, result: {} })
  })

  test('notifications produce no response', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(res).toBeNull()
  })

  test('an unknown method with an id is a method-not-found error', async () => {
    const res = await handleRpcMessage(makeServer(), {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/list',
    })
    expect(res).toMatchObject({ id: 7, error: { code: RPC_METHOD_NOT_FOUND } })
  })

  test('a malformed request is rejected', async () => {
    const res = await handleRpcMessage(makeServer(), {
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
      jsonrpc: '1.0' as any,
      id: 8,
      method: 'initialize',
    })
    expect(res).toMatchObject({ id: 8, error: { code: RPC_INVALID_REQUEST } })
  })
})

describe('handleRpcPayload', () => {
  test('handles a batch and drops notifications from the responses', async () => {
    const responses = await handleRpcPayload(makeServer(), [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 'x' } },
      },
    ])
    expect(responses.map((r) => (r as { id: unknown }).id)).toEqual([1, 2])
  })

  test('a payload of only notifications yields no responses', async () => {
    const responses = await handleRpcPayload(makeServer(), [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ])
    expect(responses).toEqual([])
  })
})
