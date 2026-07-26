import {
  type CreateCollectionInput,
  createCollectionSchema,
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
    access: { scope: MCP_SCOPES.collectionsRead, site: 'viewer' },
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const data = await listCollections(ctx.env, ctx.site.id)
      return {
        structured: data,
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
    access: { scope: MCP_SCOPES.collectionsRead, site: 'viewer' },
    annotations: { readOnlyHint: true },
    handler: async ({ slug }, ctx) => {
      const data = await getCollection(ctx.env, ctx.site.id, slug)
      return { structured: data, text: JSON.stringify(data, null, 2) }
    },
  }),

  defineTool({
    name: 'create_collection',
    title: 'Create collection',
    description:
      'Create a new collection. `slug` must be lowercase kebab-case. Omit `fields` to start ' +
      'with a default title + body pair. `kind` is "multiple" (many entries) or "single" (one).',
    args: createCollectionSchema,
    access: { scope: MCP_SCOPES.collectionsWrite, site: 'admin' },
    handler: async (input, ctx) => {
      const data = await createCollection(ctx.env, ctx.site.id, input as CreateCollectionInput)
      return { structured: data, text: `Created collection "${data.slug}".` }
    },
  }),

  defineTool({
    name: 'update_collection',
    title: 'Update collection',
    description:
      'Update a collection by slug. Only the provided keys change; `fields`, when given, ' +
      'replaces the whole field list.',
    args: slugArg.extend(updateCollectionSchema.shape),
    access: { scope: MCP_SCOPES.collectionsWrite, site: 'admin' },
    handler: async ({ slug, ...input }, ctx) => {
      const data = await updateCollection(
        ctx.env,
        ctx.site.id,
        slug,
        input as UpdateCollectionInput,
      )
      return { structured: data, text: `Updated collection "${data.slug}".` }
    },
  }),

  defineTool({
    name: 'delete_collection',
    title: 'Delete collection',
    description: 'Delete a collection by slug. Its entries are removed along with it.',
    args: slugArg,
    access: { scope: MCP_SCOPES.collectionsWrite, site: 'admin' },
    annotations: { destructiveHint: true },
    handler: async ({ slug }, ctx) => {
      await deleteCollection(ctx.env, ctx.site.id, slug)
      return { structured: { slug, deleted: true }, text: `Deleted collection "${slug}".` }
    },
  }),
]
