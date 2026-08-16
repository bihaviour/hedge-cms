import {
  type CreateCollectionInput,
  MCP_SCOPES,
  slugSchema,
  type UpdateCollectionInput,
  updateCollectionSchema,
} from '@hedge/core'
import { z } from 'zod'
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  updateCollection,
} from '../lib/collections'
import { McpToolError } from '../lib/mcp'
import { defineTool } from './registry'

const slugArg = z.object({ slug: slugSchema })

/**
 * Collection tools — the content *model*. Writing one is a site-admin power because changing a
 * field list reshapes every entry that already exists, and deleting a collection takes its entries
 * with it.
 */
export const collectionTools = [
  defineTool({
    name: 'list_collections',
    title: 'List collections',
    description: 'List every collection defined on the current site.',
    args: z.object({}),
    access: { scope: MCP_SCOPES.collectionsRead, permission: 'collections:read' },
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const data = await listCollections(ctx.env, ctx.site.id)
      return {
        structured: { data },
        text: data.length
          ? data.map((col) => `- ${col.slug} (${col.name}, ${col.fields.length} fields)`).join('\n')
          : 'No collections yet.',
      }
    },
  }),

  defineTool({
    name: 'get_collection',
    title: 'Get collection',
    description: 'Fetch one collection and its full field definitions by slug.',
    args: slugArg,
    access: { scope: MCP_SCOPES.collectionsRead, permission: 'collections:read' },
    annotations: { readOnlyHint: true },
    handler: async ({ slug }, ctx) => {
      const data = await getCollection(ctx.env, ctx.site.id, slug)
      return { structured: data, text: JSON.stringify(data, null, 2) }
    },
  }),

  defineTool({
    name: 'write_collection',
    title: 'Create or update collection',
    description:
      'Create a collection, or update the one that already has this slug. `slug` is ' +
      'lowercase kebab-case and identifies which. Creating needs `name`; omit `fields` and it ' +
      'starts with a title + body pair. Updating changes only the keys you send — but `fields`, ' +
      'when sent, replaces the whole field list rather than adding to it, so read the collection ' +
      'first and send the list you want. `kind` is "multiple" (many entries) or "single" (one).',
    // The update shape, which is the create shape with everything but `slug` optional. Carrying
    // both would inline the 13-kind field union twice for one operation with two names.
    args: slugArg.extend(updateCollectionSchema.shape),
    access: {
      scope: MCP_SCOPES.collectionsWrite,
      permission: ['collections:create', 'collections:update'],
    },
    handler: async ({ slug, ...input }, ctx) => {
      const existing = await getCollection(ctx.env, ctx.site.id, slug).catch(() => null)

      if (existing) {
        const data = await updateCollection(
          ctx.env,
          ctx.site.id,
          slug,
          input as UpdateCollectionInput,
        )
        return { structured: data, text: `Updated collection "${data.slug}".` }
      }

      // `name` is the one key a create cannot infer, and the schema cannot require it without
      // requiring it on every update too.
      if (!input.name) {
        throw new McpToolError(`No collection "${slug}" exists — creating one needs "name"`)
      }
      const data = await createCollection(ctx.env, ctx.site.id, {
        ...input,
        slug,
        name: input.name,
      } as CreateCollectionInput)
      return { structured: data, text: `Created collection "${data.slug}".` }
    },
  }),

  defineTool({
    name: 'delete_collection',
    title: 'Delete collection',
    description: 'Delete a collection by slug. Its entries are removed along with it.',
    args: slugArg,
    access: { scope: MCP_SCOPES.collectionsWrite, permission: 'collections:delete' },
    annotations: { destructiveHint: true },
    handler: async ({ slug }, ctx) => {
      await deleteCollection(ctx.env, ctx.site.id, slug)
      return { structured: { slug, deleted: true }, text: `Deleted collection "${slug}".` }
    },
  }),
]
