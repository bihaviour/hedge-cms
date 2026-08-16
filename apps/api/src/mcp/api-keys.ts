import { API_KEY_SCOPE_LABELS, createApiKeySchema, MCP_SCOPES } from '@hedge/core'
import { z } from 'zod'
import { createApiKey, deleteApiKey, listApiKeys } from '../lib/api-keys'
import { defineTool } from './registry'

/**
 * API key tools. Issuing a key is a site-admin power, matching the REST route — a key reads a whole
 * site's content.
 *
 * `create_api_key` is the one tool whose *result* is a secret: the raw key exists exactly once, in
 * that response, and is stored only as an HMAC afterwards. Through MCP that response lands in a
 * model's context and then in whatever transcript the client keeps, which is a weaker place than
 * the admin's show-once dialog. The description says so, because the model relaying it is the one
 * deciding where it goes next.
 */
export const apiKeyTools = [
  defineTool({
    name: 'list_api_keys',
    title: 'List API keys',
    description:
      'List the active site’s API keys — names, prefixes, scopes and last use. The secrets ' +
      'themselves are stored hashed and are not returned.',
    args: z.object({}),
    access: { scope: MCP_SCOPES.keysRead, permission: 'api_keys:read' },
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const data = await listApiKeys(ctx.env, ctx.site.id)
      return {
        structured: { data },
        text: data.length
          ? data
              .map((key) => `- ${key.id} ${key.name} (${key.prefix}…) [${key.scopes.join(', ')}]`)
              .join('\n')
          : 'No API keys on this site.',
      }
    },
  }),

  defineTool({
    name: 'create_api_key',
    title: 'Create API key',
    description:
      'Issue an API key for the active site. **The response contains the raw secret and it can ' +
      'never be retrieved again** — hand it to the person who asked and do not repeat it. ' +
      `Scopes: ${Object.entries(API_KEY_SCOPE_LABELS)
        .map(([scope, label]) => `\`${scope}\` — ${label}`)
        .join('; ')}. A key with only \`content:read\` is the delivery credential a public ` +
      'website holds and reaches published content only; adding any write scope makes it an ' +
      'authoring key.',
    args: createApiKeySchema,
    access: { scope: MCP_SCOPES.keysWrite, permission: 'api_keys:create' },
    handler: async (input, ctx) => {
      const data = await createApiKey(ctx.env, ctx.site.id, input, ctx.actor.id)
      return {
        structured: data,
        text: `Issued key "${data.name}" with scopes ${data.scopes.join(', ')}. The secret is in the structured result and cannot be shown again.`,
      }
    },
  }),

  defineTool({
    name: 'delete_api_key',
    title: 'Revoke API key',
    description:
      'Revoke an API key by id. Anything still presenting it starts failing immediately, so ' +
      'check what uses it first.',
    args: z.object({ id: z.string().min(1) }),
    access: { scope: MCP_SCOPES.keysWrite, permission: 'api_keys:delete' },
    annotations: { destructiveHint: true },
    handler: async ({ id }, ctx) => {
      await deleteApiKey(ctx.env, ctx.site.id, id)
      return { structured: { id, deleted: true }, text: `Revoked key ${id}.` }
    },
  }),
]
