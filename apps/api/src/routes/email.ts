import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_VARIABLES,
  type EmailConfig,
  type EmailLog,
  type EmailTemplate,
  type EmailTemplateKey,
  updateEmailConfigSchema,
  updateEmailTemplateSchema,
} from '@hedge/core'
import { desc, eq, lt } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import {
  type EmailLogRow,
  type EmailTemplateRow,
  emailConfig,
  emailLog,
  emailTemplates,
} from '../db/schema'
import { EMAIL_CONFIG_ID, loadEmailConfig } from '../email/config'
import { renderMessage } from '../email/render'
import type { AppEnv } from '../env'
import { requireActor, requireRole } from '../lib/auth'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { validate, validateQuery } from '../lib/validate'

const app = new Hono<AppEnv>()

// Email is deployment infrastructure — one binding, one from-domain — so managing it is an
// instance-admin power, the same level that manages users and sites, not a per-site role.
app.use('*', requireRole('admin'))

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

function isTemplateKey(value: string): value is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value)
}

/** Merges a stored override (if any) with the built-in default into the shape the admin renders. */
function toTemplate(key: EmailTemplateKey, row: EmailTemplateRow | undefined): EmailTemplate {
  const def = DEFAULT_EMAIL_TEMPLATES[key]
  const source = row ?? def
  return {
    key,
    label: def.label,
    description: def.description,
    variables: [...EMAIL_TEMPLATE_VARIABLES],
    subject: source.subject,
    heading: source.heading,
    body: source.body,
    ctaLabel: source.ctaLabel,
    customized: row !== undefined,
    updatedAt: row?.updatedAt ?? null,
  }
}

app.get('/templates', async (c) => {
  const rows = await getDb(c.env).select().from(emailTemplates)
  const byKey = new Map(rows.map((row) => [row.key, row]))
  return c.json({ data: EMAIL_TEMPLATE_KEYS.map((key) => toTemplate(key, byKey.get(key))) })
})

function templateKeyParam(c: Context<AppEnv>): EmailTemplateKey {
  const key = c.req.param('key')
  if (!key || !isTemplateKey(key)) throw ApiError.notFound('Email template')
  return key
}

app.get('/templates/:key', async (c) => {
  const key = templateKeyParam(c)
  const [row] = await getDb(c.env)
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.key, key))
    .limit(1)
  return c.json({ data: toTemplate(key, row) })
})

app.put('/templates/:key', async (c) => {
  const key = templateKeyParam(c)
  const input = await validate(c, updateEmailTemplateSchema)
  const actor = requireActor(c)
  const db = getDb(c.env)

  const values = {
    subject: input.subject,
    heading: input.heading,
    body: input.body,
    ctaLabel: input.ctaLabel ?? null,
    updatedBy: actor.kind === 'user' ? actor.id : null,
    updatedAt: new Date().toISOString(),
  }

  const [row] = await db
    .insert(emailTemplates)
    .values({ id: newId('etpl'), key, ...values })
    .onConflictDoUpdate({ target: emailTemplates.key, set: values })
    .returning()

  return c.json({ data: toTemplate(key, row) })
})

/** Removes the override, restoring the built-in default. Idempotent — resetting an untouched
 * template is not an error. */
app.delete('/templates/:key', async (c) => {
  const key = templateKeyParam(c)
  await getDb(c.env).delete(emailTemplates).where(eq(emailTemplates.key, key))
  return c.json({ data: toTemplate(key, undefined) })
})

/** Renders the passed draft with sample data, so the editor can preview unsaved edits. */
app.post('/templates/:key/preview', async (c) => {
  // Validates the key in the path — a preview for an unknown template is a 404 like any other.
  templateKeyParam(c)
  const input = await validate(c, updateEmailTemplateSchema)
  const message = renderMessage(
    c.env.APP_NAME,
    {
      subject: input.subject,
      heading: input.heading,
      body: input.body,
      ctaLabel: input.ctaLabel ?? null,
    },
    { to: 'reader@example.com', name: 'Alex Rivera', url: `${c.env.PUBLIC_URL}/example-link` },
  )
  return c.json({ data: { subject: message.subject, html: message.html } })
})

/* ------------------------------------------------------------------ *
 * Log
 * ------------------------------------------------------------------ */

const listLogSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

function toLog(row: EmailLogRow): EmailLog {
  return {
    id: row.id,
    to: row.to,
    subject: row.subject,
    templateKey: row.templateKey,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
  }
}

app.get('/log', async (c) => {
  const { cursor, limit } = validateQuery(c, listLogSchema)
  const rows = await getDb(c.env)
    .select()
    .from(emailLog)
    // Ids are timestamp-prefixed, so id order is send order — keyset paginate on it, newest first.
    .where(cursor ? lt(emailLog.id, cursor) : undefined)
    .orderBy(desc(emailLog.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return c.json({ data: page.map(toLog), nextCursor: hasMore ? page.at(-1)!.id : null })
})

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

function toConfig(
  env: AppEnv['Bindings'],
  row: Awaited<ReturnType<typeof loadEmailConfig>>,
): EmailConfig {
  return {
    fromEmail: row?.fromEmail ?? null,
    fromName: row?.fromName ?? null,
    replyTo: row?.replyTo ?? null,
    enabled: row?.enabled ?? true,
    defaultFromEmail: env.EMAIL_FROM,
    defaultFromName: env.EMAIL_FROM_NAME,
    updatedAt: row?.updatedAt ?? null,
  }
}

app.get('/config', async (c) => {
  const row = await loadEmailConfig(c.env)
  return c.json({ data: toConfig(c.env, row) })
})

app.patch('/config', async (c) => {
  const input = await validate(c, updateEmailConfigSchema)
  const actor = requireActor(c)
  const db = getDb(c.env)

  const existing = await loadEmailConfig(c.env)
  // A PATCH leaves unmentioned fields untouched; only the keys the caller sent are applied.
  const next = {
    fromEmail: 'fromEmail' in input ? (input.fromEmail ?? null) : (existing?.fromEmail ?? null),
    fromName: 'fromName' in input ? (input.fromName ?? null) : (existing?.fromName ?? null),
    replyTo: 'replyTo' in input ? (input.replyTo ?? null) : (existing?.replyTo ?? null),
    enabled: input.enabled ?? existing?.enabled ?? true,
    updatedBy: actor.kind === 'user' ? actor.id : null,
    updatedAt: new Date().toISOString(),
  }

  const [row] = await db
    .insert(emailConfig)
    .values({ id: EMAIL_CONFIG_ID, ...next })
    .onConflictDoUpdate({ target: emailConfig.id, set: next })
    .returning()

  return c.json({ data: toConfig(c.env, row ?? null) })
})

export default app
