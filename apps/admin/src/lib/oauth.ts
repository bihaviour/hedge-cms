/**
 * The browser half of the MCP OAuth flow.
 *
 * An MCP client sends the operator to `/api/v1/auth/mcp/authorize`. When there is no session yet,
 * Better Auth parks the request and redirects here to `/login` carrying the original query — so
 * signing in has to hand the operator back to the endpoint they were pulled out of, or the client
 * is left waiting on a callback that never comes.
 */

const AUTHORIZE_PATH = '/api/v1/auth/mcp/authorize'
const CONSENT_PATH = '/api/v1/auth/oauth2/consent'

/** The in-flight authorization request in the current URL, if there is one. */
export function pendingAuthorization(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get('client_id') ? search : null
}

/** Hands the browser back to the authorization endpoint. Returns false when nothing was pending. */
export function resumeAuthorization(search: string = window.location.search): boolean {
  const pending = pendingAuthorization(search)
  if (!pending) return false

  window.location.assign(`${AUTHORIZE_PATH}${pending}`)
  return true
}

/**
 * Approves or refuses the request, then follows Better Auth back to the client's redirect URI —
 * which carries either the authorization code or the refusal.
 */
export async function decideConsent(consentCode: string, accept: boolean): Promise<void> {
  const response = await fetch(CONSENT_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept, consent_code: consentCode }),
  })

  const payload = (await response.json().catch(() => null)) as {
    redirectURI?: string
    message?: string
  } | null

  if (!response.ok || !payload?.redirectURI) {
    throw new Error(payload?.message ?? 'Could not complete the authorization request')
  }

  window.location.assign(payload.redirectURI)
}

/** Plain-language descriptions of what a client is asking for. */
const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'See your name',
  email: 'See your email address',
  offline_access: 'Stay connected when you are not at the keyboard',
  'collections:read': 'Read this site’s collections and their fields',
  'collections:write': 'Create, change and delete collections — and the entries inside them',
}

export function describeScopes(scope: string | null): string[] {
  const requested = (scope ?? '').split(/[\s,]+/).filter(Boolean)
  return requested.map((name) => SCOPE_LABELS[name] ?? name)
}
