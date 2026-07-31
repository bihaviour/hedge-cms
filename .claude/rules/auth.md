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
| Preview token | `X-Hedge-Preview` | `resolvePreview` | one unpublished entry, on `/api/v1/content/*` only |
| MCP OAuth token | `Authorization: Bearer` | inside `routes/mcp.ts` | `/api/v1/mcp` only |

**A machine never approves an entry version** (#59). An authoring key and a delegated MCP client may
both *write* one — that is ordinary content work — but the approve, reject and publish routes carry
`requireUserActor`, and `approvalLevelFor` in `lib/auth.ts` returns 0 for anything that is not a
session actor. An approval is a statement by a person, and the credential that can author is the one
most likely to be automated. That is a third check on top of the two below, deliberately.

Approval authority itself is a *site* power, not an instance one: `site_users.approvalLevel`, per
user per site, null meaning "derive from the site role" (`approvalLevelForSiteRole`). A user reaching
a site through `sites:access_all` has no grant row and resolves to site admin, hence level 2 — by
construction, not by exemption, which is the same shape the MCP owner case has.

The two key rows are the *same credential type* separated by what it was issued to do. A key with
no write scope never leaves the delivery API, so the credential a public website holds still cannot
see a draft. Neither kind reaches users, sites, members, email, or the key routes themselves.

A preview token resolves no actor at all — it sets `preview`, not `actor`, so it widens what an
already-authenticated delivery request may see rather than authenticating one. Minting it is
`requireUserActor` only; see `api-routes.md`.

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
- **100,000 PBKDF2 iterations is workerd's ceiling, not a choice.** `deriveBits` throws
  `NotSupportedError` above it rather than running slower, and both password paths — `/auth/setup`
  writing one, `/auth/login` reading one — go through it, so a higher number is a deployment where
  nobody can sign in and the only clue is a 500. `crypto.test.ts` pins it.
- `telemetry: { enabled: false }` — nothing about a self-hosted CMS phones home.

## MCP OAuth

`index.ts` intercepts `GET /api/v1/auth/mcp/authorize` to force `prompt=consent`. Better Auth only
shows the consent screen when the client asks, and a client is under no obligation to — a token that
can rewrite the content model should never arrive from a redirect nobody read. Keep that interceptor
in front of the handler.

**The facade strips `oidc_login_prompt` before forwarding a sign-in** (`auth/forward.ts`). Better
Auth's `mcp` plugin parks a pending authorization in that cookie and its after-hook — matching every
endpoint — resumes the flow server-side as soon as any response sets a session cookie, which through
a JSON facade arrives as a `302` on `/sign-in/email` and can only be reported as `internal_error`.
The admin resumes the request itself (`resumeAuthorization` in `lib/oauth.ts`), so the server-side
resume is redundant here. Don't restore the cookie to `FORWARDED_HEADERS`' output without removing
the admin's resume first — one of the two has to own it, and only one of them can answer JSON.

Discovery documents are served from the root (`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`, plus RFC 9728's path-suffixed form). `/.well-known/*` is in
`run_worker_first` in `wrangler.jsonc` — without it the SPA fallback answers metadata requests with
`index.html`.

An MCP token is limited **twice**: by the scopes granted at consent, and by the approving user's own
role. Delivery API keys are deliberately not accepted at the MCP endpoint — the key that serves a
public website lives in that website's environment variables, the least protected place any Hedge
credential sits.

MCP tool argument schemas reuse the REST schemas from `@hedge/core`, so the MCP surface can never
accept something the HTTP API would reject. Keep it that way when adding a tool.

## The MCP tool surface (`apps/api/src/mcp/`)

The endpoint covers the whole CMS — collections, entries, media, newsletters and subscribers, sites,
users, API keys — one module per area, assembled in `mcp/index.ts`.

**A tool is defined by a scope *and* a role, and both are checked on every call** (`mcp/registry.ts`):

| | Means | Checked against |
| --- | --- | --- |
| `access.scope` | what the operator delegated to this client at consent | the token's scopes |
| `access.site` | site-level minimum, for one tenant's content | `currentSiteRole` |
| `access.instance` | instance-level minimum, for users and creating/deleting sites | `users.role` |

Neither implies the other and the narrower wins, which is what makes the surface differ per user
without any per-user configuration: the same client approved by an editor and by an owner can do
two different things. **An owner needs no special case** — `roleAtLeast` clears every minimum and
`siteRoleFor` resolves an instance owner or admin to that role on every site, so an owner passes by
construction rather than by exemption. Don't add one.

Pick the role a new tool declares by **matching the REST route that does the same thing**. Content
writes are `editor`, schema and key writes are site `admin`, user management is instance `admin`,
deleting a site is instance `owner`. A tool whose gate is looser than its route is a hole.

Adding an area means adding a `:read`/`:write` pair to `MCP_SCOPES` **and** a line to
`MCP_SCOPE_LABELS` in `packages/core/src/auth.ts` — the consent screen renders from the labels, and
a scope with no label reaches an operator as a bare `users:write` nobody can evaluate. Nothing else
needs touching: `auth/cms.ts` and the admin's consent screen both read the list.

`tools/list` is filtered by scope; dispatch is not. An ungranted tool is `hidden` but still callable,
so calling it reports the missing scope rather than "unknown tool" — which a model reads as "the CMS
cannot do this" and works around. Role failures are never hidden; a role can change between two calls
on one token.

Three REST powers are deliberately withheld, and `mcp.test.ts` pins the first and the third:

- **Sending a newsletter to its audience.** It reaches real inboxes and cannot be recalled.
  `send_test_newsletter` mails one named address, which is what an agent actually needs.
- **Uploading media.** It needs a multipart body streamed into R2; base64 through a context window
  is not a substitute. Everything *about* an upload — listing, captioning, deleting — is exposed.
- **Approving, rejecting or publishing an entry version** (#62). Authoring one and submitting it for
  review are exposed; blessing one is not. The reasoning is sharper than the newsletter's: the point
  of the workflow is a second pair of *human* eyes, and an agent approving the version it has just
  written is a rubber stamp with extra steps. Say so in any new tool description that comes near it.

`create_api_key` returns a raw secret into a model's context. That is a real weakening versus the
admin's show-once dialog, so the tool description says so; keep that warning if you touch it.
