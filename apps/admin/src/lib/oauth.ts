/**
 * The browser half of the MCP OAuth flow.
 *
 * An MCP client sends the operator to `/api/v1/auth/mcp/authorize`. When there is no session yet,
 * Better Auth parks the request and redirects here to `/login` carrying the original query — so
 * signing in has to hand the operator back to the endpoint they were pulled out of, or the client
 * is left waiting on a callback that never comes.
 */

import { MCP_SCOPE_LABELS } from '@hedge/core'

const AUTHORIZE_PATH = '/api/v1/auth/mcp/authorize'
/**
 * **Ours, not Better Auth's `/oauth2/consent`** (#145). That endpoint takes `{accept, consent_code}`
 * and grants the scope parked when the authorization request arrived, so it cannot carry what the
 * operator narrowed. Ours records the narrowing first and delegates second, which is what makes a
 * failure to record mean "no token" rather than "a token with nothing behind it".
 */
const CONSENT_PATH = '/api/v1/auth/oauth/consent'

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
export async function decideConsent(
  consentCode: string,
  clientId: string,
  accept: boolean,
  destructive: boolean,
): Promise<void> {
  const response = await fetch(CONSENT_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept, consentCode, clientId, destructive }),
  })

  const payload = (await response.json().catch(() => null)) as {
    data?: { redirectURI?: string }
    error?: { message?: string }
  } | null

  if (!response.ok || !payload?.data?.redirectURI) {
    throw new Error(payload?.error?.message ?? 'Could not complete the authorization request')
  }

  window.location.assign(payload.data.redirectURI)
}

/**
 * Plain-language descriptions of what a client is asking for. The Hedge scopes come from
 * `@hedge/core`, so a scope added to the MCP surface can never reach this screen as a bare
 * `users:write` nobody can read; only the OIDC standard ones are named here.
 */
const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'See your name',
  email: 'See your email address',
  offline_access: 'Stay connected when you are not at the keyboard',
  ...MCP_SCOPE_LABELS,
}

export function describeScopes(scope: string | null): string[] {
  const requested = (scope ?? '').split(/[\s,]+/).filter(Boolean)
  return requested.map((name) => SCOPE_LABELS[name] ?? name)
}
