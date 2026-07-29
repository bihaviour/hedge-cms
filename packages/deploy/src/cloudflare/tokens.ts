import type { CloudflareClient } from './client'

/**
 * Token verification for the update preflight.
 *
 * `/user/tokens/verify` confirms the presented token is a live Cloudflare API token — it fails fast
 * on a typo or a revoked token before anything is mutated. It does **not** enumerate the token's
 * permission groups: a token scoped only to edit Workers cannot read its own policy (that needs
 * `User API Tokens:Read`, which the update token has no business carrying). So the preflight proves
 * the permissions it needs by *using* them read-only — reading the script settings and the database
 * — and maps a 403 there to the missing permission by name. `verifyToken` is only the liveness gate.
 */

export interface TokenVerification {
  id: string
  status: string
}

/** Confirm the token is active. Throws `CloudflareError` (401) for an invalid or revoked token. */
export async function verifyToken(client: CloudflareClient): Promise<TokenVerification> {
  const result = await client.request<{ id: string; status: string }>('GET', '/user/tokens/verify')
  return { id: result.id, status: result.status }
}
