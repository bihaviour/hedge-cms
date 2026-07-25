import { publicSubscribeSchema } from '@hedge/core'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/client'
import { memberSites, newsletterSubscribers } from '../db/schema'
import type { AppEnv } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { type RecipientKind, verifyUnsubscribeToken } from '../lib/newsletter'
import { requireSite } from '../lib/site'
import { throttle } from '../lib/throttle'
import { validate } from '../lib/validate'

/**
 * Public newsletter endpoints — mounted at /api/v1/newsletter, resolving no actor. A website's
 * signup form posts here, and the unsubscribe link in every newsletter lands here. The site is
 * resolved the usual way: an explicit `?site=`, or the `Host` matching `sites.domain`.
 */
const app = new Hono<AppEnv>()

app.post('/subscribe', async (c) => {
  const site = requireSite(c)
  const input = await validate(c, publicSubscribeSchema)
  await throttle(c, `newsletter-subscribe:${site.id}`, { window: 3600, max: 20 })

  const db = getDb(c.env)
  const email = input.email.toLowerCase()

  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(and(eq(newsletterSubscribers.siteId, site.id), eq(newsletterSubscribers.email, email)))
    .limit(1)

  // Idempotent by design: signing up twice, or after unsubscribing, just leaves the address
  // subscribed. The response never reveals whether the address was already on the list.
  if (existing) {
    if (existing.status !== 'subscribed') {
      await db
        .update(newsletterSubscribers)
        .set({ status: 'subscribed', unsubscribedAt: null, updatedAt: new Date().toISOString() })
        .where(eq(newsletterSubscribers.id, existing.id))
    }
    return c.json({ data: { ok: true } })
  }

  await db.insert(newsletterSubscribers).values({
    id: newId('nsub'),
    siteId: site.id,
    email,
    name: input.name ?? null,
    source: input.source ?? 'signup',
  })

  return c.json({ data: { ok: true } })
})

/**
 * The unsubscribe link. A GET so it works straight from an email client, returning a small HTML
 * page rather than JSON. The signed token binds the link to one recipient on one site, so it cannot
 * be forged or aimed at another address.
 */
app.get('/unsubscribe', async (c) => {
  const site = requireSite(c)
  const kind = c.req.query('kind')
  const id = c.req.query('id')
  const token = c.req.query('token')

  if (kind !== 'subscriber' && kind !== 'member')
    throw ApiError.badRequest('Invalid unsubscribe link')
  if (!id || !token) throw ApiError.badRequest('Invalid unsubscribe link')

  const ok = await verifyUnsubscribeToken(c.env, kind as RecipientKind, site.id, id, token)
  if (!ok) throw ApiError.badRequest('This unsubscribe link is invalid or has expired')

  const db = getDb(c.env)
  const now = new Date().toISOString()

  if (kind === 'subscriber') {
    await db
      .update(newsletterSubscribers)
      .set({ status: 'unsubscribed', unsubscribedAt: now, updatedAt: now })
      .where(and(eq(newsletterSubscribers.id, id), eq(newsletterSubscribers.siteId, site.id)))
  } else {
    // A member keeps their account and gated-content access — only the newsletter opt-in is cleared.
    await db
      .update(memberSites)
      .set({ newsletterSubscribed: false })
      .where(and(eq(memberSites.memberId, id), eq(memberSites.siteId, site.id)))
  }

  return c.html(unsubscribePage(site.name))
})

function unsubscribePage(siteName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Unsubscribed</title>
  </head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f6f7;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
    <div style="max-width:420px;background:#fff;border-radius:12px;padding:32px;text-align:center">
      <h1 style="margin:0 0 12px;font-size:20px">You're unsubscribed</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#3f3f46">You will no longer receive the ${escapeText(siteName)} newsletter. Changed your mind? You can sign up again anytime.</p>
    </div>
  </body>
</html>`
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export default app
