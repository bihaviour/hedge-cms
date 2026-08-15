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

/** Expands an IPv6 literal to its eight 16-bit groups, or `null` if it is not one. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(':')) return null

  const [head, tail, ...rest] = host.split('::')
  if (rest.length > 0) return null

  const parse = (part: string): number[] | null => {
    if (!part) return []
    const out: number[] = []
    for (const piece of part.split(':')) {
      // A trailing dotted quad, as in `::ffff:127.0.0.1`, is two groups written the other way.
      const quad = piece.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (quad) {
        const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number]
        if ([a, b, c, d].some((n) => n > 255)) return null
        out.push((a << 8) | b, (c << 8) | d)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }

  const left = parse(head ?? '')
  if (!left) return null
  if (tail === undefined) return left.length === 8 ? left : null

  const right = parse(tail)
  if (!right || left.length + right.length > 7) return null
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
}

/**
 * Hostnames and literal addresses that must never be fetched. Loopback and link-local first (the
 * classic metadata-service targets), then RFC 1918 and unique-local, then the names a container
 * platform resolves internally.
 *
 * **IPv6 is parsed, not pattern-matched, because one address has many spellings.** `::ffff:127.0.0.1`
 * and `::ffff:7f00:1` are the same address, and the WHATWG URL parser normalises the readable one
 * *into* the hex one — so a check that only understood the dotted form would never fire on anything
 * `new URL()` actually produced. Every IPv4-in-IPv6 embedding (v4-mapped, v4-compatible, and the
 * NAT64 well-known prefix) is unwrapped and re-checked as the v4 address it carries.
 *
 * The dotted-quad branch needs no such care: this is only ever handed `url.hostname`, and the URL
 * parser has already turned `2130706433`, `0x7f000001`, `017700000001` and `127.1` into `127.0.0.1`.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true

  const groups = ipv6Groups(host)
  if (groups) {
    // Always eight groups by construction; the defaults are only here to keep them typed `number`.
    const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = groups

    // `::`, `::1`, and anything else in the first /96 that is not an embedded v4 address.
    const lowIsAll = (from: number) => groups.slice(0, from).every((g) => g === 0)

    if (g0 === 0 && lowIsAll(7) && g7 <= 1) return true
    if ((g0 & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
    if ((g0 & 0xffc0) === 0xfe80) return true // link-local fe80::/10

    // An embedded IPv4 address is that address, whichever spelling carried it here.
    const embedded =
      (lowIsAll(5) && g5 === 0xffff) || // ::ffff:a.b.c.d — v4-mapped
      (lowIsAll(6) && g6 !== 0) || // ::a.b.c.d — v4-compatible, deprecated but routable
      (g0 === 0x0064 && g1 === 0xff9b && lowIsAll(6)) // 64:ff9b::/96 — NAT64
    if (embedded) {
      const quad = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.')
      return isBlockedHost(quad)
    }
    return false
  }

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
