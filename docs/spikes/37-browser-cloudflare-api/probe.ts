#!/usr/bin/env bun
/**
 * Spike #37 — does `api.cloudflare.com` permit cross-origin browser requests?
 *
 * Issues the CORS preflight a browser would send before each call the installer needs, and prints
 * what comes back. No token and no browser: a preflight is sent *without* credentials, which is
 * exactly why holding a correctly-scoped token cannot change the outcome. If no response carries
 * `access-control-allow-origin`, the browser refuses every one of these calls from any page, and the
 * installer cannot be a static page — see README.md in this directory.
 *
 *   bun docs/spikes/37-browser-cloudflare-api/probe.ts [origin]
 */

const API_BASE = 'https://api.cloudflare.com/client/v4'
const ORIGIN = process.argv[2] ?? 'https://install.hedge.example'

/** A stand-in account id: a preflight is routed and answered without ever reading the path's ids. */
const ACCOUNT = '0'.repeat(32)
const SCRIPT = 'hedge-cms'

interface Probe {
  label: string
  method: string
  path: string
  /** The headers the real request would carry — what the preflight asks permission for. */
  requestHeaders: string[]
}

const PROBES: Probe[] = [
  {
    label: 'token verify',
    method: 'GET',
    path: '/user/tokens/verify',
    requestHeaders: ['authorization'],
  },
  {
    label: 'create D1 database',
    method: 'POST',
    path: `/accounts/${ACCOUNT}/d1/database`,
    requestHeaders: ['authorization', 'content-type'],
  },
  {
    label: 'create R2 bucket',
    method: 'POST',
    path: `/accounts/${ACCOUNT}/r2/buckets`,
    requestHeaders: ['authorization', 'content-type'],
  },
  {
    label: 'assets upload session',
    method: 'POST',
    path: `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/assets-upload-session`,
    requestHeaders: ['authorization', 'content-type'],
  },
  {
    // The issue flagged this as the likeliest failure. It isn't special: `multipart/form-data` is a
    // safelisted Content-Type, so the bearer header is what preflights it — as on every row above.
    label: 'assets upload (multipart + JWT)',
    method: 'POST',
    path: `/accounts/${ACCOUNT}/workers/assets/upload`,
    requestHeaders: ['authorization'],
  },
  {
    label: 'upload + deploy Worker',
    method: 'PUT',
    path: `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`,
    requestHeaders: ['authorization'],
  },
]

interface Outcome {
  label: string
  status: number | string
  allowOrigin: string | null
  allowHeaders: string | null
  allowMethods: string | null
  /** True only if a browser would let the real request proceed. */
  permitted: boolean
}

async function preflight(probe: Probe): Promise<Outcome> {
  try {
    const response = await fetch(`${API_BASE}${probe.path}`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': probe.method,
        'access-control-request-headers': probe.requestHeaders.join(','),
      },
    })

    const allowOrigin = response.headers.get('access-control-allow-origin')
    const allowHeaders = response.headers.get('access-control-allow-headers')
    return {
      label: probe.label,
      status: response.status,
      allowOrigin,
      allowHeaders,
      allowMethods: response.headers.get('access-control-allow-methods'),
      // The browser's actual test: the origin has to be echoed or wildcarded, *and* every
      // non-safelisted header the real request carries has to be named as allowed.
      permitted:
        response.ok &&
        (allowOrigin === '*' || allowOrigin === ORIGIN) &&
        probe.requestHeaders.every((header) => allows(allowHeaders, header)),
    }
  } catch (error) {
    return {
      label: probe.label,
      status: error instanceof Error ? error.message : String(error),
      allowOrigin: null,
      allowHeaders: null,
      allowMethods: null,
      permitted: false,
    }
  }
}

function allows(allowHeaders: string | null, header: string): boolean {
  if (!allowHeaders) return false
  if (allowHeaders.trim() === '*') return true
  return allowHeaders
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .includes(header)
}

const results: Outcome[] = []
for (const probe of PROBES) results.push(await preflight(probe))

console.log(`Preflighting ${API_BASE} as Origin: ${ORIGIN}\n`)
for (const result of results) {
  const verdict = result.permitted ? 'ALLOWED' : 'BLOCKED'
  console.log(`${verdict.padEnd(8)} ${result.label}`)
  console.log(`         status ${result.status}`)
  console.log(`         access-control-allow-origin:  ${result.allowOrigin ?? '(absent)'}`)
  console.log(`         access-control-allow-headers: ${result.allowHeaders ?? '(absent)'}`)
  console.log(`         access-control-allow-methods: ${result.allowMethods ?? '(absent)'}`)
}

const allowed = results.filter((result) => result.permitted).length
console.log(`\n${allowed}/${results.length} calls would be permitted from a browser.`)
console.log(
  allowed === results.length
    ? 'CORS is supported — the installer could be a static page, and spike #37 should be revisited.'
    : 'CORS is not supported — the installer needs a same-origin proxy. This is what #37 concluded.',
)
