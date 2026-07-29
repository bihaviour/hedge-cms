import type { HedgeAsset } from '@hedge/core'
import type { CloudflareClient } from './client'

/**
 * The Workers static-assets direct-upload flow, in two calls.
 *
 * 1. `assets-upload-session` posts the manifest — every asset keyed by its 32-char hash — and gets
 *    back a JWT and `buckets`: the hashes Cloudflare doesn't already have. Unchanged files are
 *    absent, which is what makes most updates cheap. If `buckets` is empty, the JWT it returned *is*
 *    the completion token and the second call is skipped entirely.
 * 2. `assets/upload?base64=true` uploads each bucket as multipart form-data, the file's base64 body
 *    keyed by its hash. The final bucket's response carries the completion JWT, which the version
 *    upload then references as `assets.jwt`.
 */

export interface AssetUploadSession {
  /** The JWT authorising the uploads, or — when nothing needs uploading — the completion token. */
  jwt: string
  /** Buckets of asset hashes still to upload. Empty when the deployment already has every file. */
  buckets: string[][]
}

/**
 * Open an upload session for a script's assets. The manifest maps the served path to its hash and
 * size; Cloudflare replies with only the hashes it is missing.
 */
export async function createAssetUploadSession(
  client: CloudflareClient,
  scriptName: string,
  assets: HedgeAsset[],
): Promise<AssetUploadSession> {
  const manifest: Record<string, { hash: string; size: number }> = {}
  for (const asset of assets) {
    manifest[asset.path] = { hash: asset.hash, size: asset.size }
  }

  const result = await client.request<{ jwt: string; buckets?: string[][] }>(
    'POST',
    `/accounts/${client.accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    { manifest },
  )
  return { jwt: result.jwt, buckets: result.buckets ?? [] }
}

/** The bytes and content type for one asset, looked up by its manifest hash while uploading. */
export interface AssetPayload {
  bytes: Uint8Array
  contentType: string
}

/**
 * Upload the buckets a session asked for, returning the completion token.
 *
 * Each bucket is one request; the file body is base64 (the `?base64=true` the endpoint expects) and
 * the part's `Content-Type` is what Cloudflare will serve the file as — derived from the path in CI
 * and carried in the manifest, because getting it wrong breaks the SPA in confusing ways. The
 * completion token arrives on the response to the last bucket.
 */
export async function uploadAssets(
  client: CloudflareClient,
  session: AssetUploadSession,
  payloadFor: (hash: string) => AssetPayload,
): Promise<string> {
  // Nothing changed: the session JWT is already the completion token.
  if (session.buckets.length === 0) return session.jwt

  let completionToken = ''
  for (const bucket of session.buckets) {
    const form = new FormData()
    for (const hash of bucket) {
      const { bytes, contentType } = payloadFor(hash)
      form.append(hash, new Blob([toBase64(bytes)], { type: contentType }), hash)
    }

    const result = await client.requestForm<{ jwt?: string }>(
      'POST',
      `/accounts/${client.accountId}/workers/assets/upload`,
      form,
      { bearer: session.jwt, query: { base64: 'true' } },
    )
    if (result.jwt) completionToken = result.jwt
  }

  if (!completionToken) {
    throw new Error('asset upload completed without returning a completion token')
  }
  return completionToken
}

/** base64 without pulling in a dependency — the buffers here are one asset at a time, not the SPA. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked so a large asset doesn't blow the argument limit of `String.fromCharCode`.
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
