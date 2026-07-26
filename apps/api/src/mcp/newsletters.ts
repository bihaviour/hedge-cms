import {
  createNewsletterSchema,
  createNewsletterTemplateSchema,
  createSubscriberSchema,
  MCP_SCOPES,
  NEWSLETTER_AUDIENCES,
  testSendSchema,
  updateNewsletterSchema,
  updateNewsletterTemplateSchema,
  updateSubscriberSchema,
} from '@hedge/core'
import { z } from 'zod'
import {
  createNewsletter,
  createNewsletterTemplate,
  createSubscriber,
  deleteNewsletter,
  deleteNewsletterTemplate,
  deleteSubscriber,
  getNewsletter,
  getNewsletterTemplate,
  listNewsletters,
  listNewsletterTemplates,
  listSubscribers,
  resolveRecipients,
  sendTestNewsletter,
  updateNewsletter,
  updateNewsletterTemplate,
  updateSubscriber,
} from '../lib/newsletter'
import { defineTool } from './registry'

/**
 * Email tools: reusable templates, the campaigns drafted from them, and the subscriber list.
 *
 * **Sending to the whole audience is deliberately not here.** Every other write in this file is
 * something a person can look at and undo; a send reaches real inboxes, cannot be recalled, and
 * marks the newsletter permanently non-editable. `send_test_newsletter` covers the case an agent
 * actually needs — seeing the rendered result — by mailing one address the caller names.
 */

const idArg = z.object({ id: z.string().min(1) })

export const newsletterTools = [
  /* ---------------------------------------------------------------- *
   * Templates
   * ---------------------------------------------------------------- */

  defineTool({
    name: 'list_newsletter_templates',
    title: 'List email templates',
    description: 'List this site’s reusable newsletter templates.',
    args: z.object({}),
    access: { scope: MCP_SCOPES.newslettersRead, site: 'editor' },
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const data = await listNewsletterTemplates(ctx.env, ctx.site.id)
      return {
        structured: data,
        text: data.length
          ? data.map((tpl) => `- ${tpl.id} ${tpl.name} — "${tpl.subject}"`).join('\n')
          : 'No templates yet.',
      }
    },
  }),

  defineTool({
    name: 'get_newsletter_template',
    title: 'Get email template',
    description: 'Fetch one template by id, with its full subject and body.',
    args: idArg,
    access: { scope: MCP_SCOPES.newslettersRead, site: 'editor' },
    annotations: { readOnlyHint: true },
    handler: async ({ id }, ctx) => {
      const data = await getNewsletterTemplate(ctx.env, ctx.site.id, id)
      return { structured: data, text: JSON.stringify(data, null, 2) }
    },
  }),

  defineTool({
    name: 'create_newsletter_template',
    title: 'Create email template',
    description:
      'Create a reusable email template. `body` is the message content; the site’s newsletter ' +
      'shell and unsubscribe footer are added at send time, so do not write your own.',
    args: createNewsletterTemplateSchema,
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    handler: async (input, ctx) => {
      const data = await createNewsletterTemplate(ctx.env, ctx.site.id, input, ctx.actor.id)
      return { structured: data, text: `Created template "${data.name}" (${data.id}).` }
    },
  }),

  defineTool({
    name: 'update_newsletter_template',
    title: 'Update email template',
    description: 'Update a template by id. Only the keys you pass change.',
    args: updateNewsletterTemplateSchema.extend(idArg.shape),
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    handler: async ({ id, ...input }, ctx) => {
      const data = await updateNewsletterTemplate(ctx.env, ctx.site.id, id, input)
      return { structured: data, text: `Updated template "${data.name}".` }
    },
  }),

  defineTool({
    name: 'delete_newsletter_template',
    title: 'Delete email template',
    description: 'Delete a template. Campaigns already drafted from it are unaffected.',
    args: idArg,
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    annotations: { destructiveHint: true },
    handler: async ({ id }, ctx) => {
      await deleteNewsletterTemplate(ctx.env, ctx.site.id, id)
      return { structured: { id, deleted: true }, text: `Deleted template ${id}.` }
    },
  }),

  /* ---------------------------------------------------------------- *
   * Campaigns
   * ---------------------------------------------------------------- */

  defineTool({
    name: 'list_newsletters',
    title: 'List newsletters',
    description: 'List this site’s newsletters — drafts and already-sent alike, newest first.',
    args: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
    access: { scope: MCP_SCOPES.newslettersRead, site: 'editor' },
    annotations: { readOnlyHint: true },
    handler: async (query, ctx) => {
      const page = await listNewsletters(ctx.env, ctx.site.id, query)
      return {
        structured: page,
        text: page.data.length
          ? page.data
              .map((n) => `- ${n.id} [${n.status}] "${n.subject}" → ${n.audience}`)
              .join('\n')
          : 'No newsletters yet.',
      }
    },
  }),

  defineTool({
    name: 'get_newsletter',
    title: 'Get newsletter',
    description: 'Fetch one newsletter by id, with its full body and send status.',
    args: idArg,
    access: { scope: MCP_SCOPES.newslettersRead, site: 'editor' },
    annotations: { readOnlyHint: true },
    handler: async ({ id }, ctx) => {
      const data = await getNewsletter(ctx.env, ctx.site.id, id)
      return { structured: data, text: JSON.stringify(data, null, 2) }
    },
  }),

  defineTool({
    name: 'create_newsletter',
    title: 'Draft newsletter',
    description:
      'Draft a newsletter. It is created unsent and stays editable until somebody sends it from ' +
      'the admin — this tool cannot send it. `audience` picks the subscriber list, the site’s ' +
      'members, or both deduplicated by email.',
    args: createNewsletterSchema,
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    handler: async (input, ctx) => {
      const data = await createNewsletter(ctx.env, ctx.site.id, input, ctx.actor.id)
      return {
        structured: data,
        text: `Drafted newsletter "${data.subject}" (${data.id}) for ${data.audience}. Not sent.`,
      }
    },
  }),

  defineTool({
    name: 'update_newsletter',
    title: 'Update newsletter',
    description:
      'Update a draft newsletter. A newsletter that has already been sent is a record of what ' +
      'went out and cannot be edited.',
    args: updateNewsletterSchema.extend(idArg.shape),
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    handler: async ({ id, ...input }, ctx) => {
      const data = await updateNewsletter(ctx.env, ctx.site.id, id, input)
      return { structured: data, text: `Updated newsletter "${data.subject}".` }
    },
  }),

  defineTool({
    name: 'delete_newsletter',
    title: 'Delete newsletter',
    description: 'Delete a newsletter. Deleting a sent one destroys the record that it went out.',
    args: idArg,
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    annotations: { destructiveHint: true },
    handler: async ({ id }, ctx) => {
      await deleteNewsletter(ctx.env, ctx.site.id, id)
      return { structured: { id, deleted: true }, text: `Deleted newsletter ${id}.` }
    },
  }),

  defineTool({
    name: 'count_newsletter_recipients',
    title: 'Count newsletter recipients',
    description:
      'How many addresses an audience reaches right now, deduplicated. Check this before asking ' +
      'somebody to send.',
    args: z.object({ audience: z.enum(NEWSLETTER_AUDIENCES).default('both') }),
    access: { scope: MCP_SCOPES.newslettersRead, site: 'editor' },
    annotations: { readOnlyHint: true },
    handler: async ({ audience }, ctx) => {
      const recipients = await resolveRecipients(ctx.env, ctx.site.id, audience)
      return {
        structured: { audience, count: recipients.length },
        text: `${recipients.length} recipient(s) for "${audience}".`,
      }
    },
  }),

  defineTool({
    name: 'send_test_newsletter',
    title: 'Send test newsletter',
    description:
      'Send a single copy of a newsletter to one address, subject-prefixed with [Test], so a ' +
      'human can see the rendered result. This does **not** send to the audience — no MCP tool ' +
      'does; a real send happens from the admin.',
    args: testSendSchema.extend(idArg.shape),
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'admin' },
    handler: async ({ id, email }, ctx) => {
      await sendTestNewsletter(ctx.env, ctx.site, id, email)
      return { structured: { id, sentTo: email }, text: `Sent a test copy to ${email}.` }
    },
  }),

  /* ---------------------------------------------------------------- *
   * Subscribers
   * ---------------------------------------------------------------- */

  defineTool({
    name: 'list_subscribers',
    title: 'List subscribers',
    description: 'List this site’s newsletter subscribers. `q` filters by email substring.',
    args: z.object({
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
    access: { scope: MCP_SCOPES.newslettersRead, site: 'editor' },
    annotations: { readOnlyHint: true },
    handler: async (query, ctx) => {
      const page = await listSubscribers(ctx.env, ctx.site.id, query)
      return {
        structured: page,
        text: page.data.length
          ? page.data.map((sub) => `- ${sub.id} ${sub.email} [${sub.status}]`).join('\n')
          : 'No subscribers yet.',
      }
    },
  }),

  defineTool({
    name: 'add_subscriber',
    title: 'Add subscriber',
    description:
      'Add an address to the subscriber list. A previously unsubscribed address is re-subscribed ' +
      'rather than duplicated. Only add addresses whose owner asked to be added.',
    args: createSubscriberSchema,
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    handler: async (input, ctx) => {
      const data = await createSubscriber(ctx.env, ctx.site.id, input, 'mcp')
      return { structured: data, text: `Subscribed ${data.email}.` }
    },
  }),

  defineTool({
    name: 'update_subscriber',
    title: 'Update subscriber',
    description: 'Change a subscriber’s name, or set their status to subscribed / unsubscribed.',
    args: updateSubscriberSchema.extend(idArg.shape),
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    handler: async ({ id, ...input }, ctx) => {
      const data = await updateSubscriber(ctx.env, ctx.site.id, id, input)
      return { structured: data, text: `Updated ${data.email} → ${data.status}.` }
    },
  }),

  defineTool({
    name: 'delete_subscriber',
    title: 'Delete subscriber',
    description:
      'Remove a subscriber outright. To stop mailing somebody, prefer setting their status to ' +
      '"unsubscribed" — deleting the row loses the record that they opted out.',
    args: idArg,
    access: { scope: MCP_SCOPES.newslettersWrite, site: 'editor' },
    annotations: { destructiveHint: true },
    handler: async ({ id }, ctx) => {
      await deleteSubscriber(ctx.env, ctx.site.id, id)
      return { structured: { id, deleted: true }, text: `Deleted subscriber ${id}.` }
    },
  }),
]
