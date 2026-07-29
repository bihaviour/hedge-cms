import type { CloudflareClient } from './client'

/**
 * The accounts a token can reach.
 *
 * Only the installer needs this: an update already knows its account (the operator is looking at a
 * deployment that exists), whereas an install has to ask. Asking is better than a text field —
 * an account id is a 32-character hex string nobody remembers, and pasting the wrong one produces a
 * permission error that reads like a bad token.
 */

export interface CloudflareAccountSummary {
  id: string
  name: string
}

export async function listAccounts(client: CloudflareClient): Promise<CloudflareAccountSummary[]> {
  const result = await client.request<Array<{ id: string; name: string }>>('GET', '/accounts')
  return result.map((account) => ({ id: account.id, name: account.name }))
}
