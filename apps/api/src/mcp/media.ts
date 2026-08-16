import {
  listMediaQuerySchema,
  MAX_INLINE_UPLOAD_BYTES,
  MCP_SCOPES,
  updateMediaSchema,
  uploadMediaSchema,
} from '@hedge/core'
import { z } from 'zod'
import { ApiError } from '../lib/errors'
import { deleteMedia, getMedia, listMedia, storeUpload, updateMedia } from '../lib/media'
import { fetchRemoteFile } from '../lib/remote-file'
import { defineTool } from './registry'

/**
 * Media tools: the library, and putting something into it.
 *
 * Uploading used to be withheld from this surface, on the grounds that it needs a body streamed
 * into R2 and that base64 through a context window is not a substitute. The second half of that is
 * still true and is why `data` is capped an order of magnitude below the REST limit — but it was
 * never an argument against uploading, only against one *transport* for it. The common case is a
 * URL, and a URL costs the context window nothing: the Worker fetches it and streams the body into
 * R2 exactly as the multipart route does, through the same `storeUpload`.
 */
/**
 * Turns the `data` argument into a stream `storeUpload` can consume.
 *
 * The cap is enforced on the *decoded* length rather than the base64 length, because the number in
 * the refusal has to be the same number the tool description promised. A `data:` prefix is stripped
 * and its media type used when the caller named none — models write it both ways, and refusing the
 * form they produced most often would be a refusal about punctuation.
 */
function decodeInlineUpload(
  data: string,
  declared?: string,
): { body: ReadableStream<Uint8Array>; contentType: string; filename: string } {
  let payload = data.trim()
  let contentType = declared

  const prefix = payload.match(/^data:([^;,]+)?(?:;[^,]*)*,/)
  if (prefix) {
    contentType ??= prefix[1]
    payload = payload.slice(prefix[0].length)
  }

  let bytes: Uint8Array
  try {
    const binary = atob(payload.replace(/\s+/g, ''))
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    throw ApiError.badRequest('"data" is not valid base64')
  }

  if (bytes.byteLength > MAX_INLINE_UPLOAD_BYTES) {
    throw new ApiError(
      'payload_too_large',
      `Inline uploads must be under ${MAX_INLINE_UPLOAD_BYTES} bytes — pass "url" instead for a file this size`,
    )
  }

  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    contentType: contentType || 'application/octet-stream',
    filename: 'file',
  }
}

export const mediaTools = [
  defineTool({
    name: 'upload_media',
    title: 'Upload media',
    description:
      'Add a file to this site’s media library and return it with its public URL, ready to ' +
      'reference from an entry. Give **`url`** wherever the file already has one — it is fetched ' +
      'and stored without passing through this conversation, and it is the option to reach for. ' +
      '`data` takes base64 and exists only for a file with no URL because you have just produced ' +
      `it (a generated SVG or chart); it is capped at ${MAX_INLINE_UPLOAD_BYTES} bytes, so do not ` +
      'use it to move a large file you could have linked. Exactly one of the two.',
    args: uploadMediaSchema,
    // Behind the destructive grant despite being purely additive (#145): it writes a file into the
    // bucket and reaches outside the deployment to do it, which is a power an operator may not want
    // an agent to have even when they are happy for it to caption what is already there. It carries
    // no `destructiveHint`, because that annotation is what a client reads to decide whether to ask
    // a human, and claiming an upload may destroy something would be false.
    access: { scope: MCP_SCOPES.mediaWrite, site: 'editor', destructive: true },
    handler: async (input, ctx) => {
      const source = input.url
        ? await fetchRemoteFile(input.url)
        : decodeInlineUpload(input.data!, input.contentType)

      const data = await storeUpload(ctx.env, ctx.site, {
        body: source.body,
        filename: input.filename || source.filename,
        contentType: input.contentType || source.contentType,
        alt: input.alt ?? null,
        // Always a user: the MCP endpoint resolves an OAuth token to the operator who approved it.
        uploadedBy: ctx.actor.kind === 'user' ? ctx.actor.id : null,
      })

      return {
        structured: data,
        text: `Uploaded "${data.filename}" (${data.size} bytes) → ${data.url}`,
      }
    },
  }),

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
      'move — this is metadata only, which makes it the tool for captioning a backlog of images. ' +
      'The value you send replaces the old one and nothing keeps a copy of it.',
    args: updateMediaSchema.extend({ id: z.string().min(1) }),
    // An overwrite with no history is not an additive update, so it needs the grant (#145). No
    // `destructiveHint` either: a client would prompt a human before every caption fix, which is
    // the wrong trade for a tool whose whole point is working through a backlog.
    access: { scope: MCP_SCOPES.mediaWrite, site: 'editor', destructive: true },
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
