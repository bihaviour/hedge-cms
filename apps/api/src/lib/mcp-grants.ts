import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { mcpClientGrants } from '../db/schema'
import type { Bindings } from '../env'
import { newId } from './id'

/**
 * What an operator narrowed when they approved an MCP client (#145).
 *
 * This is **our** authorization layer, not Better Auth's. Better Auth's `/oauth2/consent` takes
 * `{accept, consent_code}` and nothing else — the scope was parked server-side when the
 * authorization request arrived, and the endpoint writes it into `oauth_consents` verbatim. So a
 * narrowing cannot be expressed through it at all, and reaching into the parked verification row to
 * rewrite it would mean depending on Better Auth's internal shape for something that must fail
 * closed. Recording the decision beside it and applying it where the tools are built does not.
 *
 * **A missing row means granted.** Every consent given before this existed has none and has to keep
 * working, which is the same rule `INSTALLED_BY` unset follows. A row is written only to record
 * what an operator decided, and `false` is the only value that changes anything.
 */

/** Whether this client may reach the tools that delete or overwrite, for this user. */
export async function destructiveGrantFor(
  env: Bindings,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const [row] = await getDb(env)
    .select({ destructive: mcpClientGrants.destructive })
    .from(mcpClientGrants)
    .where(and(eq(mcpClientGrants.userId, userId), eq(mcpClientGrants.clientId, clientId)))
    .limit(1)

  return row?.destructive ?? true
}

/**
 * Records the decision, before the consent that depends on it is given.
 *
 * Order is the whole of the safety argument: the caller writes this *first* and approves second, so
 * a failure here means no token is ever issued. Approving first and recording second would leave a
 * window in which a live token exists with no narrowing behind it — and since a missing row means
 * granted, that window would default to the widest answer.
 */
export async function setDestructiveGrant(
  env: Bindings,
  userId: string,
  clientId: string,
  destructive: boolean,
): Promise<void> {
  const now = new Date().toISOString()

  await getDb(env)
    .insert(mcpClientGrants)
    .values({ id: newId('grant'), userId, clientId, destructive, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [mcpClientGrants.userId, mcpClientGrants.clientId],
      set: { destructive, updatedAt: now },
    })
}

/** Every grant this user has recorded, so the account page can say what each client may do. */
export async function destructiveGrantsFor(
  env: Bindings,
  userId: string,
): Promise<Map<string, boolean>> {
  const rows = await getDb(env)
    .select({ clientId: mcpClientGrants.clientId, destructive: mcpClientGrants.destructive })
    .from(mcpClientGrants)
    .where(eq(mcpClientGrants.userId, userId))

  return new Map(rows.map((row) => [row.clientId, row.destructive]))
}
