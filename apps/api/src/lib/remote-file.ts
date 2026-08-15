import { MAX_UPLOAD_BYTES } from '@hedge/core'
import { ApiError } from './errors'

/**
 * Fetching a caller-supplied URL from inside the Worker.
 *
 * This is the deployment's first *outbound* request driven by caller input, and that makes it an
 * SSRF surface rather than a convenience. The caller is a delegated MCP client holding `editor` on
 * the site — not anonymous, but not a person either: it is a model, and a model can be talked into
 * fetching a URL somebody put in an entry. So the guards here are the point of the module, and
 * `fetchRemoteFile` is deliberately the only export.
 *
 * One limit is stated rather than papered over: **workerd resolves DNS itself and hands us no
 * address**, so a public hostname whose A record points into private space passes every check
 * below. Blocking that needs resolution we do not have. What is defensible — literal private hosts,
 * the schemes, redirects, the size — is enforced; pretending the rest is covered would be worse
 * than the gap.
 */

const TIMEOUT_MS = 15_000

/**
 * Hostnames and literal addresses that must never be fetched. Loopback and link-local first (the
 * classic metadata-service targets), then RFC 1918 and unique-local, then the names a container
 * platform resolves internally.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true

  // IPv6, including the IPv4-mapped form an allowlist written for dotted quads would miss.
  if (host === '::1' || host === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true // unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true // link-local fe80::/10
  if (host.startsWith('::ffff:')) return isBlockedHost(host.slice('::ffff:'.length))

  const quad = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!quad) return false
  const [a, b] = [Number(quad[1]), Number(quad[2])]

  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local, and 169.254.169.254 with it
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a >= 224) return true // multicast and reserved
  return false
}

export interface RemoteFile {
  body: ReadableStream<Uint8Array>
  /** From the response, never from the caller — see `uploadMediaSchema`. */
  contentType: string
  /** The last path segment, for a caller that supplied no filename of its own. */
  filename: string
}

/**
 * Fetches a URL for upload, or throws an `ApiError` a caller can act on.
 *
 * Redirects are **not followed**. A redirect is the ordinary way around a host check — the first
 * hop passes, the second lands wherever it likes — and re-running the check per hop is a loop with
 * a state machine in it for a case nobody has asked for. `redirect: 'manual'` turns it into a clear
 * refusal instead, naming the target so the caller can pass the real URL.
 */
export async function fetchRemoteFile(rawUrl: string): Promise<RemoteFile> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw ApiError.badRequest(`"${rawUrl}" is not a URL`)
  }

  // https only. `http:` is not merely insecure here — it is the scheme every internal service
  // speaks, so allowing it would undo most of the host check's value.
  if (url.protocol !== 'https:') {
    throw ApiError.badRequest(`Only https URLs can be uploaded — "${url.protocol}" is not allowed`)
  }
  if (isBlockedHost(url.hostname)) {
    throw ApiError.badRequest(`"${url.hostname}" is not a public host`)
  }

  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: '*/*' },
  }).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : 'the request failed'
    throw ApiError.badRequest(`Could not fetch ${url.href} — ${reason}`)
  })

  if (response.status >= 300 && response.status < 400) {
    const target = response.headers.get('location')
    throw ApiError.badRequest(
      `${url.href} redirects${target ? ` to ${target}` : ''}; redirects are not followed. ` +
        'Pass the URL it redirects to.',
    )
  }
  if (!response.ok || !response.body) {
    throw ApiError.badRequest(`Could not fetch ${url.href} — it answered ${response.status}`)
  }

  // The claimed length is checked before a byte is read, so an obviously oversized file costs
  // nothing. It is a claim, though, and `storeUpload` counts what actually arrives.
  const claimed = Number(response.headers.get('content-length') ?? 0)
  if (claimed > MAX_UPLOAD_BYTES) {
    void response.body.cancel()
    throw new ApiError('payload_too_large', `Files must be under ${MAX_UPLOAD_BYTES} bytes`)
  }

  const name = decodeURIComponent(url.pathname.split('/').pop() || '') || 'file'

  return {
    body: response.body,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    filename: name,
  }
}
