import {
  createEntrySchema,
  createEntryVersionSchema,
  listEntriesQuerySchema,
  listEntryVersionsQuerySchema,
  localeCodeSchema,
  MCP_SCOPES,
  slugSchema,
  updateEntrySchema,
} from '@hedge/core'
import { z } from 'zod'
import {
  createEntry,
  deleteEntry,
  getEntry,
  listEntries,
  listEntryRevisions,
  restoreEntryRevision,
  updateEntry,
} from '../lib/entries'
import { createEntryVersion, listEntryVersions, submitEntryVersion } from '../lib/entry-versions'
import { defineTool } from './registry'

/**
 * Entry tools — the content itself. Writing is an `editor` power, matching the REST routes: a
 * person who can draft and publish a post through the admin can do the same through an agent, and
 * neither can reshape the collection it lives in without also being a site admin.
 */

/** Every entry tool takes the collection it operates in, and optionally a locale. */
const target = z.object({
  collection: slugSchema.describe('Slug of the collection the entry belongs to'),
  locale: localeCodeSchema.optional().describe("Defaults to the site's default locale"),
})

const entryTarget = target.extend({ slug: slugSchema })

const summarise = (entry: { slug: string; status: string; locale: string }) =>
  `${entry.slug} [${entry.status}] (${entry.locale})`

export const entryTools = [
  defineTool({
    name: 'list_entries',
    title: 'List entries',
    description:
      'List entries in a collection, newest first by default. Returns drafts as well as ' +
      'published entries — filter with `status` to narrow. Paginate with `cursor` from the ' +
      'previous result.',
    // Not `target.shape`: on a list, `locale` is a filter rather than which copy to load.
    args: listEntriesQuerySchema.extend({
      collection: slugSchema.describe('Slug of the collection to list entries from'),
    }),
    access: { scope: MCP_SCOPES.entriesRead, site: 'viewer' },
    annotations: { readOnlyHint: true },
    handler: async ({ collection, ...query }, ctx) => {
      const page = await listEntries(ctx.env, ctx.site, collection, query)
      return {
        structured: page,
        text: page.data.length
          ? page.data.map((entry) => `- ${summarise(entry)}`).join('\n')
          : 'No entries match.',
      }
    },
  }),

  defineTool({
    name: 'get_entry',
    title: 'Get entry',
    description: 'Fetch one entry by slug, with all of its field data and metadata.',
    args: entryTarget,
    access: { scope: MCP_SCOPES.entriesRead, site: 'viewer' },
    annotations: { readOnlyHint: true },
    handler: async ({ collection, slug, locale }, ctx) => {
      const data = await getEntry(ctx.env, ctx.site, collection, slug, locale)
      return { structured: data, text: JSON.stringify(data, null, 2) }
    },
  }),

  defineTool({
    name: 'create_entry',
    title: 'Create entry',
    description:
      "Create an entry in a collection. `data` is keyed by the collection's field names and is " +
      'validated against them, so read the collection first if you are unsure. Defaults to a ' +
      'draft — pass `status: "published"` to publish immediately. A slug is derived from the ' +
      'title when omitted.',
    args: createEntrySchema.extend({
      collection: slugSchema.describe('Slug of the collection to create the entry in'),
    }),
    access: { scope: MCP_SCOPES.entriesWrite, site: 'editor' },
    handler: async ({ collection, ...input }, ctx) => {
      const data = await createEntry(ctx.env, ctx.site, collection, input, ctx.actor.id)
      return { structured: data, text: `Created entry ${summarise(data)} in "${collection}".` }
    },
  }),

  defineTool({
    name: 'update_entry',
    title: 'Update entry',
    description:
      'Update an entry by slug. Only the keys you pass change, and `data`, when given, replaces ' +
      'the whole field map. The previous state is snapshotted as a revision first, so an edit is ' +
      'always recoverable. Moving `status` to "published" publishes it; back to "draft" ' +
      'unpublishes it.',
    // `slug` and `locale` identify the entry to load; `newSlug` and `newLocale` move it. Flattening
    // `updateEntrySchema` in as-is would give each name two jobs and make a rename indistinguishable
    // from a lookup.
    args: entryTarget.extend({
      ...updateEntrySchema.omit({ slug: true, locale: true }).shape,
      newSlug: slugSchema.optional().describe('Rename the entry to this slug'),
      newLocale: localeCodeSchema.optional().describe('Move the entry to this locale'),
    }),
    access: { scope: MCP_SCOPES.entriesWrite, site: 'editor' },
    handler: async ({ collection, slug, locale, newSlug, newLocale, ...input }, ctx) => {
      const data = await updateEntry(
        ctx.env,
        ctx.site,
        collection,
        slug,
        { ...input, slug: newSlug, locale: newLocale },
        ctx.actor.id,
        locale,
      )
      return { structured: data, text: `Updated entry ${summarise(data)}.` }
    },
  }),

  defineTool({
    name: 'delete_entry',
    title: 'Delete entry',
    description:
      'Delete one entry, in one locale. This is not recoverable through revisions — the ' +
      'revision history goes with it.',
    args: entryTarget,
    access: { scope: MCP_SCOPES.entriesWrite, site: 'editor' },
    annotations: { destructiveHint: true },
    handler: async ({ collection, slug, locale }, ctx) => {
      await deleteEntry(ctx.env, ctx.site, collection, slug, locale)
      return { structured: { collection, slug, deleted: true }, text: `Deleted entry "${slug}".` }
    },
  }),

  defineTool({
    name: 'list_entry_revisions',
    title: 'List entry revisions',
    description:
      'The last 50 saved states of an entry, newest first, with who made each one. Use a ' +
      'revision id with `restore_entry_revision`.',
    args: entryTarget,
    access: { scope: MCP_SCOPES.entriesRead, site: 'editor' },
    annotations: { readOnlyHint: true },
    handler: async ({ collection, slug, locale }, ctx) => {
      const data = await listEntryRevisions(ctx.env, ctx.site, collection, slug, locale)
      return {
        structured: data,
        text: data.length
          ? data
              .map(
                (rev) =>
                  `- ${rev.id} [${rev.status}] ${rev.createdAt} by ${rev.createdByName ?? 'unknown'}`,
              )
              .join('\n')
          : 'No revisions yet.',
      }
    },
  }),

  defineTool({
    name: 'restore_entry_revision',
    title: 'Restore entry revision',
    description:
      'Roll an entry back to an earlier revision. The current state is snapshotted first, so the ' +
      'restore is itself undoable.',
    args: entryTarget.extend({ revisionId: z.string().min(1) }),
    access: { scope: MCP_SCOPES.entriesWrite, site: 'editor' },
    handler: async ({ collection, slug, revisionId, locale }, ctx) => {
      const data = await restoreEntryRevision(
        ctx.env,
        ctx.site,
        collection,
        slug,
        revisionId,
        ctx.actor.id,
        locale,
      )
      return { structured: data, text: `Restored ${summarise(data)} from revision ${revisionId}.` }
    },
  }),

  /* ---------------------------------------------------------------- *
   * Entry versions — proposed future states of an entry.
   *
   * Authoring one is exposed; **approving, rejecting and publishing one are deliberately withheld**,
   * the same call the endpoint already makes about sending a newsletter and for a sharper reason: an
   * agent approving the version it has just written is not review, it is a rubber stamp with extra
   * steps. The whole point of the workflow is a second pair of *human* eyes, and a tool that lets a
   * model supply them empties it out. `mcp.test.ts` pins their absence.
   * ---------------------------------------------------------------- */

  defineTool({
    name: 'list_entry_versions',
    title: 'List entry versions',
    description:
      'Open and finished versions of an entry — proposed future states of it, each authored by ' +
      'one person and sitting beside the live row rather than on top of it. Shows who wrote each, ' +
      'where it is in review, and whether it was written against an older copy of the article.',
    args: entryTarget.extend(listEntryVersionsQuerySchema.shape),
    access: { scope: MCP_SCOPES.entriesRead, site: 'viewer' },
    annotations: { readOnlyHint: true },
    handler: async ({ collection, slug, locale, ...query }, ctx) => {
      const data = await listEntryVersions(ctx.env, ctx.site, collection, slug, query, locale)
      return {
        structured: data,
        text: data.length
          ? data
              .map(
                (version) =>
                  `- ${version.id} [${version.status}] "${version.title}" by ${version.createdByName ?? 'unknown'}${version.stale ? ' (stale base)' : ''}`,
              )
              .join('\n')
          : 'No versions yet.',
      }
    },
  }),

  defineTool({
    name: 'create_entry_version',
    title: 'Create entry version',
    description:
      'Start a new version of an entry without touching what is live. Omit `data` to fork the ' +
      'entry exactly as it stands. `title` is your one-line summary of what this version does — ' +
      'it is how a reviewer tells three open versions apart. Publishing it needs a person: submit ' +
      'it for review and a human approves and publishes it.',
    args: entryTarget.extend(createEntryVersionSchema.shape),
    access: { scope: MCP_SCOPES.entriesWrite, site: 'editor' },
    handler: async ({ collection, slug, locale, ...input }, ctx) => {
      const data = await createEntryVersion(
        ctx.env,
        ctx.site,
        collection,
        slug,
        input,
        ctx.actor.id,
        locale,
      )
      return { structured: data, text: `Created version ${data.id} — "${data.title}".` }
    },
  }),

  defineTool({
    name: 'submit_entry_version',
    title: 'Submit entry version for review',
    description:
      "Put a version in front of the site's approvers. It is frozen from then on — a change " +
      'means an approver sends it back first, which resets the levels it had cleared. You cannot ' +
      'approve or publish it yourself; those are decisions only a signed-in person can make.',
    args: entryTarget.extend({ versionId: z.string().min(1) }),
    access: { scope: MCP_SCOPES.entriesWrite, site: 'editor' },
    handler: async ({ collection, slug, versionId, locale }, ctx) => {
      const data = await submitEntryVersion(ctx.env, ctx.site, collection, slug, versionId, locale)
      return {
        structured: data,
        text: `Submitted version ${data.id} for review — it needs ${data.requiredLevels} approval(s).`,
      }
    },
  }),
]
