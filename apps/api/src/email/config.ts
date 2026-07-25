import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { type EmailConfigRow, emailConfig } from '../db/schema'
import type { Bindings } from '../env'

/** The singleton row's id — email config is deployment-wide, so there is exactly one. */
export const EMAIL_CONFIG_ID = 'default'

/**
 * The stored sender configuration, or null when none has been saved. Best-effort: a missing or
 * unreadable config must fall back to the environment defaults rather than block a send.
 */
export async function loadEmailConfig(env: Bindings): Promise<EmailConfigRow | null> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(emailConfig)
      .where(eq(emailConfig.id, EMAIL_CONFIG_ID))
      .limit(1)
    return row ?? null
  } catch (error) {
    console.error('[email] config lookup failed, using defaults', error)
    return null
  }
}
