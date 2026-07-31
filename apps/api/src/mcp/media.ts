import { listMediaQuerySchema, MCP_SCOPES, updateMediaSchema } from '@hedge/core'
import { z } from 'zod'
import { deleteMedia, getMedia, listMedia, updateMedia } from '../lib/media'
import { defineTool } from './registry'

/**
 * Media tools cover everything about an upload except the upload itself: creating one means
 * streaming a multipart body into R2, which does not survive a JSON-RPC round trip, and
 * base64-ing a file through a model's context window is not a serious substitute. Files arrive
 * through the admin or `POST /api/v1/media`; from there an agent can catalogue and curate them.
 */
export const mediaTools = [
  defineTool({
    name: 'list_media',
    title: 'List media',
    description:
      'List uploaded media for the current site, newest first. Each item carries its public URL, ' +
      'so this is how you find an image to reference from an entry. Narrow a large library with ' +
      '`q` (matched against filename and alt text) or `type`.',
    // The REST schema, so this tool cannot accept something `GET /api/v1/media` would reject.
    args: listMediaQuerySchema,
    access: { scope: MCP_SCOPES.mediaRead, site: 'viewer' },
    annotations: { readOnlyHint: true },
    handler: async (query, ctx) => {
      const page = await listMedia(ctx.env, ctx.site.id, query)
      return {
        structured: page,
        text: page.data.length
          ? page.data.map((item) => `- ${item.id} ${item.filename} → ${item.url}`).join('\n')
          : 'No media uploaded yet.',
      }
    },
  }),

  defineTool({
    name: 'get_media',
    title: 'Get media',
    description: 'Fetch one media item by id, including its dimensions, alt text and public URL.',
    args: z.object({ id: z.string().min(1) }),
    access: { scope: MCP_SCOPES.mediaRead, site: 'viewer' },
    annotations: { readOnlyHint: true },
    handler: async ({ id }, ctx) => {
      const data = await getMedia(ctx.env, ctx.site.id, id)
      return { structured: data, text: JSON.stringify(data, null, 2) }
    },
  }),

  defineTool({
    name: 'update_media',
    title: 'Update media',
    description:
      'Change a media item’s alt text or display filename. The stored object and its URL do not ' +
      'move — this is metadata only, which makes it the tool for captioning a backlog of images.',
    args: updateMediaSchema.extend({ id: z.string().min(1) }),
    access: { scope: MCP_SCOPES.mediaWrite, site: 'editor' },
    handler: async ({ id, ...input }, ctx) => {
      const data = await updateMedia(ctx.env, ctx.site.id, id, input)
      return { structured: data, text: `Updated media "${data.filename}".` }
    },
  }),

  defineTool({
    name: 'delete_media',
    title: 'Delete media',
    description:
      'Delete a media item and the file behind it. Any entry still pointing at its URL will ' +
      'break — there is no reference check, and this cannot be undone.',
    args: z.object({ id: z.string().min(1) }),
    access: { scope: MCP_SCOPES.mediaWrite, site: 'editor' },
    annotations: { destructiveHint: true },
    handler: async ({ id }, ctx) => {
      await deleteMedia(ctx.env, ctx.site.id, id)
      return { structured: { id, deleted: true }, text: `Deleted media ${id}.` }
    },
  }),
]
