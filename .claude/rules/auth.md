# Rule: Authentication (`apps/api/src/auth/`, `routes/auth.ts`, `routes/mcp.ts`)

Read before touching sessions, invites, members, or the MCP OAuth server.

## Two Better Auth instances, separate tables

- `auth/cms.ts` — operators. Owns the OAuth 2.1 server the MCP endpoint sits behind.
- `auth/member.ts` — website visitors who unlock gated content on one site.

They share no tables, so a member token isn't merely rejected by the admin API — it is
*unresolvable* there, and no bug in a role check can promote one into a CMS user. Preserve that
separation; don't reach across instances or reuse a table between them.

Both are cached per isolate in a `WeakMap` keyed on `env` (`getCmsAuth` / `getMemberAuth`).
Constructing one parses config and builds a plugin route table, which is wasted work per request.
`env` is stable for the life of an isolate, so this is safe.

**Better Auth owns identity** — sessions, password hashing, verification and reset tokens, the OAuth
server. **Authorization is ours** and nothing in `auth/` reads `users.role` or `site_users`.

## Credentials in this deployment

| Credential | Presented as | Resolved by | Reaches |
| --- | --- | --- | --- |
| Admin session | signed cookie | `resolveSessionActor` | management API |
| Delivery API key (`content:read` only) | `Authorization: Bearer hdg_…` | `resolveDeliveryActor` | `/api/v1/content/*` only |
| Authoring API key (any `:write` scope) | `Authorization: Bearer hdg_…` | `resolveSessionOrKeyActor` | the above, plus `/collections/*` and `/media/*` |
| Member token | `X-Member-Token` | `resolveMember` | gated delivery content; never the admin API |
| MCP OAuth token | `Authorization: Bearer` | inside `routes/mcp.ts` | `/api/v1/mcp` only |

The two key rows are the *same credential type* separated by what it was issued to do. A key with
no write scope never leaves the delivery API, so the credential a public website holds still cannot
see a draft. Neither kind reaches users, sites, members, email, or the key routes themselves.

`Actor.kind` is *who* is acting; `Actor.via` is what they presented. Both matter — `requireUserActor`
rejects keys and delegated clients even when the role would allow the action.

## Fixed policy — don't relax without a reason in the commit message

- `disableSignUp: true` on the CMS instance. There is no public sign-up on a CMS: the first owner
  comes from `/setup`, everyone else from an invite. This closes Better Auth's own
  `/api/v1/auth/sign-up/email`.
- Nobody ever sets somebody else's password. Users and members alike are added by email and choose
  their own via a token link.
- `revokeSessionsOnPasswordReset: true` — a reset is how someone who lost control recovers.
- Password hashing is PBKDF2-SHA256 via Web Crypto in `pbkdf2$iterations$salt$hash` format
  (`lib/crypto.ts`), matching the pre-Better-Auth format so existing hashes keep working. Changing
  it forces every user through a reset.
- `telemetry: { enabled: false }` — nothing about a self-hosted CMS phones home.

## MCP OAuth

`index.ts` intercepts `GET /api/v1/auth/mcp/authorize` to force `prompt=consent`. Better Auth only
shows the consent screen when the client asks, and a client is under no obligation to — a token that
can rewrite the content model should never arrive from a redirect nobody read. Keep that interceptor
in front of the handler.

Discovery documents are served from the root (`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`, plus RFC 9728's path-suffixed form). `/.well-known/*` is in
`run_worker_first` in `wrangler.jsonc` — without it the SPA fallback answers metadata requests with
`index.html`.

An MCP token is limited **twice**: by the scopes granted at consent, and by the approving user's own
role on the site (`routes/mcp.ts` re-checks `currentSiteRole` / `userRole`). Delivery API keys are
deliberately not accepted at the MCP endpoint — the key that serves a public website lives in that
website's environment variables, the least protected place any Hedge credential sits.

MCP tool argument schemas reuse the REST schemas from `@hedge/core`, so the MCP surface can never
accept something the HTTP API would reject. Keep it that way when adding a tool.
