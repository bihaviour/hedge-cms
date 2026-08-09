import type {
  CreateEmailSenderInput,
  EmailSender,
  Site,
  UpdateEmailSenderInput,
  UpdateSenderAssignmentInput,
} from '@hedge/core'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type EmailSenderRow, emailSenders, newsletters, sites } from '../db/schema'
import type { Bindings } from '../env'
import { ApiError } from './errors'
import { newId } from './id'
import { toSite } from './sites'

/**
 * A site's address book of sender identities (#136) — the addresses it may send from, which the
 * Email tab lists and assigns roles to. Every function is scoped to one site; the address is unique
 * per site, so a duplicate is a `conflict`.
 */

export function toEmailSender(row: EmailSenderRow): EmailSender {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    replyTo: row.replyTo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** The whole list for a site, newest first. Small per site, so it is returned whole and paged in
 * the client — the same treatment users, sites and API keys get. */
export async function listSenders(env: Bindings, siteId: string): Promise<EmailSender[]> {
  const rows = await getDb(env)
    .select()
    .from(emailSenders)
    .where(eq(emailSenders.siteId, siteId))
    .orderBy(emailSenders.createdAt)
  return rows.map(toEmailSender)
}

/** Loads a sender that belongs to this site, or 404s. */
async function findSender(env: Bindings, siteId: string, id: string): Promise<EmailSenderRow> {
  const [row] = await getDb(env)
    .select()
    .from(emailSenders)
    .where(and(eq(emailSenders.id, id), eq(emailSenders.siteId, siteId)))
    .limit(1)
  if (!row) throw ApiError.notFound('Sender')
  return row
}

export async function createSender(
  env: Bindings,
  siteId: string,
  input: CreateEmailSenderInput,
): Promise<EmailSender> {
  await assertEmailFree(env, siteId, input.email)
  const [row] = await getDb(env)
    .insert(emailSenders)
    .values({
      id: newId('esnd'),
      siteId,
      email: input.email,
      name: input.name ?? null,
      replyTo: input.replyTo ?? null,
    })
    .returning()
  return toEmailSender(row!)
}

export async function updateSender(
  env: Bindings,
  siteId: string,
  id: string,
  input: UpdateEmailSenderInput,
): Promise<EmailSender> {
  const existing = await findSender(env, siteId, id)
  if (input.email !== undefined && input.email !== existing.email) {
    await assertEmailFree(env, siteId, input.email)
  }

  const [row] = await getDb(env)
    .update(emailSenders)
    .set({
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(emailSenders.id, id), eq(emailSenders.siteId, siteId)))
    .returning()
  return toEmailSender(row!)
}

/**
 * Deletes a sender and un-points anything that named it — the site's member/newsletter assignment
 * and any draft campaign's pick — so nothing is left holding a dead id. A send would fall back the
 * same way regardless (a missing sender resolves to the CMS sender), but leaving the pointers set
 * would make the Email tab claim an assignment that no longer exists.
 */
export async function deleteSender(env: Bindings, siteId: string, id: string): Promise<void> {
  await findSender(env, siteId, id)
  const db = getDb(env)
  await db.delete(emailSenders).where(and(eq(emailSenders.id, id), eq(emailSenders.siteId, siteId)))

  const now = new Date().toISOString()
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1)
  if (site) {
    const clear: Record<string, string | null> = {}
    if (site.memberSenderId === id) clear.memberSenderId = null
    if (site.newsletterSenderId === id) clear.newsletterSenderId = null
    if (Object.keys(clear).length > 0) {
      await db
        .update(sites)
        .set({ ...clear, updatedAt: now })
        .where(eq(sites.id, siteId))
    }
  }
  await db
    .update(newsletters)
    .set({ senderId: null, updatedAt: now })
    .where(and(eq(newsletters.siteId, siteId), eq(newsletters.senderId, id)))
}

/**
 * Sets which listed address is the site's member sender and which its newsletter sender. Each id is
 * either null (inherit the CMS sender) or a sender that belongs to *this* site — a cross-tenant id
 * is refused rather than silently ignored, so the caller learns the assignment did not take.
 */
export async function assignSenders(
  env: Bindings,
  siteId: string,
  input: UpdateSenderAssignmentInput,
): Promise<Site> {
  await assertBelongs(env, siteId, input.memberSenderId)
  await assertBelongs(env, siteId, input.newsletterSenderId)

  const [row] = await getDb(env)
    .update(sites)
    .set({
      memberSenderId: input.memberSenderId,
      newsletterSenderId: input.newsletterSenderId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sites.id, siteId))
    .returning()
  if (!row) throw ApiError.notFound('Site')
  return toSite(row)
}

async function assertBelongs(env: Bindings, siteId: string, id: string | null): Promise<void> {
  if (id === null) return
  await findSender(env, siteId, id)
}

async function assertEmailFree(env: Bindings, siteId: string, email: string): Promise<void> {
  const [clash] = await getDb(env)
    .select({ id: emailSenders.id })
    .from(emailSenders)
    .where(and(eq(emailSenders.siteId, siteId), eq(emailSenders.email, email)))
    .limit(1)
  if (clash) throw ApiError.conflict(`"${email}" is already a sender for this site`)
}
