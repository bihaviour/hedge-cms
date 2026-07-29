import { type CloudflareClient, CloudflareError } from './client'

/**
 * R2 bucket provisioning, for the installer (#38). The updater never needs this — an existing
 * deployment already has its bucket, and carries the binding forward by `inherit`.
 *
 * A bucket is addressed by *name* rather than by an id, so the `MEDIA` binding on a version is the
 * name itself. That is why `wrangler.jsonc` can name `hedge-media` and stay account-agnostic.
 */

/** True when a bucket of this name already exists on the account. */
export async function findBucket(client: CloudflareClient, name: string): Promise<boolean> {
  try {
    await client.request(
      'GET',
      `/accounts/${client.accountId}/r2/buckets/${encodeURIComponent(name)}`,
    )
    return true
  } catch (error) {
    if (error instanceof CloudflareError && error.status === 404) return false
    throw error
  }
}

/**
 * Create a bucket, or accept the one already named this.
 *
 * Idempotent for the same reason `createDatabase` is: a resumed install must not orphan a bucket.
 * Cloudflare answers a duplicate name with 409, which is the success case on a retry, not an error.
 */
export async function createBucket(
  client: CloudflareClient,
  name: string,
): Promise<{ created: boolean }> {
  if (await findBucket(client, name)) return { created: false }

  try {
    await client.request('POST', `/accounts/${client.accountId}/r2/buckets`, { name })
    return { created: true }
  } catch (error) {
    if (error instanceof CloudflareError && error.status === 409) return { created: false }
    throw error
  }
}
