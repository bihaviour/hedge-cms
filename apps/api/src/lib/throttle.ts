import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { getDb } from '../db/client'
import { rateLimits } from '../db/schema'
import type { AppEnv } from '../env'
import { ApiError } from './errors'
import { newId } from './id'

export interface ThrottleRule {
  /** Seconds the window covers. */
  window: number
  /** Requests allowed inside one window. */
  max: number
}

/**
 * A fixed-window limiter over the same `rate_limits` table Better Auth uses.
 *
 * The member API needs its own because those routes call Better Auth's server API directly rather
 * than through its HTTP handler — a website signs in from its own origin, so the handler's `Origin`
 * check cannot apply, and the rate limiting that lives beside it does not either.
 *
 * The counter is in the database rather than in memory on purpose: an isolate is short-lived and
 * there are many of them, so an in-memory count is a budget an attacker can reset at will.
 */
export async function throttle(
  c: Context<AppEnv>,
  action: string,
  rule: ThrottleRule,
  subject?: string,
): Promise<void> {
  // Who is being counted. The caller's address by default — but a route that sends mail wants the
  // *recipient* counted too, because an inbox has to be protected from a caller that keeps moving,
  // and an IP-keyed limit is the one an attacker resets for free. See `POST /member/magic-link`.
  const key = `${action}:${subject ?? clientIp(c) ?? 'unknown'}`
  const db = getDb(c.env)
  const now = Date.now()

  const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1)

  if (!row) {
    await db
      .insert(rateLimits)
      .values({ id: newId('rlm'), key, count: 1, lastRequest: now })
      .onConflictDoNothing()
    return
  }

  if (now - row.lastRequest > rule.window * 1000) {
    await db.update(rateLimits).set({ count: 1, lastRequest: now }).where(eq(rateLimits.key, key))
    return
  }

  if (row.count >= rule.max) {
    const retryAfter = Math.ceil((row.lastRequest + rule.window * 1000 - now) / 1000)
    c.header('retry-after', String(Math.max(retryAfter, 1)))
    throw ApiError.rateLimited()
  }

  await db
    .update(rateLimits)
    .set({ count: row.count + 1, lastRequest: now })
    .where(eq(rateLimits.key, key))
}

/** The caller's address, as Cloudflare reports it. Also what the mint route records in its log. */
export function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? null
}
