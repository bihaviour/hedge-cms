# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/bihaviour/hedge-cms/security/advisories/new)
rather than opening a public issue.

Include what you can: affected version or commit, reproduction steps, and impact. We aim to
acknowledge reports within a few days and will keep you updated as we work on a fix.

## Scope

Hedge is early-stage software and has not been independently audited. Treat any deployment as
production-sensitive: it holds your content, your users' credentials, and your API keys.

## The four credentials, and what each one reaches

Which credential a route accepts is decided by where the route lives, not by each handler
remembering to check — so a credential cannot reach a surface it was not issued for even if that
surface's own authorisation is wrong.

| Credential | Held by | Reaches | Never reaches |
| ---------- | ------- | ------- | ------------- |
| Session cookie (Better Auth, signed, `HttpOnly`) | A CMS user's browser | The management API | — |
| OAuth 2.1 access token (PKCE, 1 hour) | An MCP client, acting for one user | `/api/v1/mcp` | The management API |
| `hdg_` API key | A website frontend | `/api/v1/content/*` | The management API, MCP |
| Member token | A signed-in website visitor | Gated delivery content | Anything under the admin API |

Members authenticate against a **separate Better Auth instance over separate tables**. A member
token is not merely rejected by the management API — it is unresolvable there, so no missed role
check can promote one into an operator.

## Operational notes

- `AUTH_SECRET` signs Better Auth's cookies and tokens, and keys the HMAC used for delivery API
  keys and invite tokens. Set it with `wrangler secret put AUTH_SECRET` — never commit it, and
  rotate it if it leaks. Rotating it invalidates every session, API key, and outstanding invite.
- Passwords are hashed with PBKDF2-SHA256 (210,000 iterations), the strongest KDF available in
  the Workers runtime. API keys and invite tokens are stored only as HMACs.
- Sign-in, password reset and the OAuth token endpoint are rate limited, with the counters in D1
  rather than in memory — a Worker isolate is short-lived, so an in-memory budget is one an
  attacker resets by being routed somewhere new.
- Changing or resetting a password ends every other session for that account.
- Every MCP authorization request goes through a consent screen, whether or not the client asked
  for one. A token that acts as an admin is never issued by a redirect nobody read.
- No account's password is ever chosen by somebody else. Users and members are both added by
  email, and the invited person sets their own credential from a single-use link — so a password
  is never known to the admin who created the account, transmitted over an admin API, or left
  sitting in a support ticket. The API refuses a `password` field on those routes rather than
  ignoring it.
- `POST /api/v1/auth/setup` creates the first owner account and refuses to run once any user
  exists. Better Auth's own sign-up endpoint is disabled, so this is the only route to a first
  account. Complete setup immediately after deploying.
- API keys are scoped. Grant `content:read` to public site consumers and nothing more.
