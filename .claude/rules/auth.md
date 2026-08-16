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
| Trusted-device cookie | `hedge_device` cookie | `isTrustedDevice` | nothing — it only *skips a step* |
| Delivery API key (`content:read` only) | `Authorization: Bearer hdg_…` | `resolveDeliveryActor` | `/api/v1/content/*` only |
| Authoring API key (any `:write` scope) | `Authorization: Bearer hdg_…` | `resolveSessionOrKeyActor` | the above, plus `/collections/*` and `/media/*` |
| Sign-in API key (`members:session`) | `Authorization: Bearer hdg_…` | `resolveSessionOrKeyActor` | the delivery API, plus `/member-sessions` |
| Member token | `X-Member-Token` | `resolveMember` | gated delivery content; never the admin API |
| Preview token | `X-Hedge-Preview` | `resolvePreview` | one unpublished entry, on `/api/v1/content/*` only |
| MCP OAuth token | `Authorization: Bearer` | inside `routes/mcp.ts` | `/api/v1/mcp` only |

**A machine never approves an entry version** (#59). An authoring key and a delegated MCP client may
both *write* one — that is ordinary content work — but the approve, reject and publish routes carry
`requireUserActor`, and `approvalLevelFor` in `lib/auth.ts` returns 0 for anything that is not a
session actor. An approval is a statement by a person, and the credential that can author is the one
most likely to be automated. That is a third check on top of the two below, deliberately.

Approval authority itself is a *site* power, not an instance one: `site_users.approvalLevel`, per
user per site, null meaning "derive from the site role" (`approvalLevelForSiteRole`). It stayed a
**level** when everything else became a matrix (#151), and a grant naming a *custom* role derives 0
— there is no ladder position to read, and inventing approval authority out of "may edit entries"
is the conflation this workflow exists to prevent. Set the level on the grant to give one. A user reaching
a site through `sites:access_all` has no grant row and resolves to site admin, hence level 2 — by
construction, not by exemption, which is the same shape the MCP owner case has.

The three key rows are the *same credential type* separated by what it was issued to do. A key with
no scope beyond `content:read` never leaves the delivery API, so the credential a public website
holds still cannot see a draft. None of them reaches users, sites, email, or the key routes
themselves, and none of them reaches `/api/v1/members` — the member *list*, with its addresses,
stays a person's route.

## Signing a reader in without their password (#108)

Two additions, for the two ways a reader arrives at gated content. Both are built on the principle
the member API already had — **nobody but the member ever knows their password** — and neither
weakens it, because minting a session is not knowing a credential.

**`POST /api/v1/member-sessions`** takes a trusted server's word that it has authenticated somebody.
Four things about it are load-bearing:

- **Its own prefix, not `POST /members/:id/session`.** The prefix is what decides which credential
  is resolved at all, and `/api/v1/members` is session-only for a good reason. A route that needs a
  *wider* credential than its prefix grants cannot say so in the route — only a narrower one can —
  so it moves. `/api/v1/newsletter` beside `/api/v1/newsletters` is the same split.
- **Its own scope.** `members:session` reaches this route and nothing else, and `roleForScopes` maps
  it to site `admin` for the same reason `collections:write` maps there: issuing any key already
  requires being a site admin, so this manufactures no authority its creator lacked. A key holding
  it can read anything that site gates behind membership, which is a real widening and is why it is
  a scope an operator grants deliberately rather than a power the admin role gained.
- **The session is Better Auth's own** (`mintMemberSession`), created through `internalAdapter`
  rather than by writing `member_sessions` by hand. `/member/me`, logout and the daily rotation
  cannot tell it from a password sign-in, and there is no second definition of a session to keep in
  step. There is **no `expiresIn`**: `updateAge` resets a session's expiry to the instance-wide
  lifetime on first use, so a shorter TTL would be a promise the runtime breaks within a day.
- **A `pending` member is minted for.** They have no password — which is the point — and the caller
  has already authenticated them. Refusing would make just-in-time provisioning impossible. It is
  the surprising half of the decision, so it is written down in the route.

**`POST /api/v1/member/magic-link`** and its `GET …/verify` cover the reader who arrives from a
search result with nothing to be handed over from. `disableSignUp` is on: the facade refuses an
unknown address before any mail is sent, because the plugin would otherwise mint an identity per
address typed into a form, including on an invite-only site. The token comes back to the website in
the URL **fragment**, which browsers never send to a server.

Both routes end at `grantForSignIn`, which is the tenant boundary: blocked is refused, invite-only
is refused, an open site is joined. On the magic-link path Better Auth has already created a session
by the time that runs, so **a refusal deletes it** — a live token nobody was handed is still a live
token. Redeeming a link also flips `emailVerified` and, on an unverified account, deletes the
password (`revokeUnprovenAccountAccess`): a credential set before anyone proved they own the mailbox
is not evidence of anything. Say so anywhere this behaviour is surfaced; it reads as data loss
otherwise.

A preview token resolves no actor at all — it sets `preview`, not `actor`, so it widens what an
already-authenticated delivery request may see rather than authenticating one. Minting it is
`requireUserActor` only; see `api-routes.md`.

`Actor.kind` is *who* is acting; `Actor.via` is what they presented. Both matter — `requireUserActor`
rejects keys and delegated clients even when the role would allow the action.

## Step-up verification on an unrecognised device (`lib/login-verification.ts`)

A correct password from a browser the account has never been seen on does not produce a session. It
produces a six-digit code mailed to the address on the account, and only that finishes the sign-in.
This is the one check aimed at a password that has already leaked — everything else in this file
protects the credential rather than noticing a valid one arriving from somewhere new.

Four things about it are load-bearing:

- **The device is what is remembered, not the IP address.** A phone changes address several times a
  day, so an IP-sensitive check would mail codes that often and train people to click through them.
  `trusted_devices` holds `hmac(AUTH_SECRET, deviceId)` against a user, the cookie holds the opaque
  id, and trust slides forward on each use up to `TRUSTED_DEVICE_TTL_DAYS`. Don't add an IP term.
- **The session is created before the code and parked, not after it.** Better Auth owns identity, so
  the second step cannot mint a session it has no password for — re-deriving one here would mean
  forging Better Auth's own cookie. So `/sign-in/email` runs at step one and its `Set-Cookie` values
  sit in `login_challenges.sessionCookies` until the code comes back. That is a live credential in
  D1 for a few minutes, which is the same class of secret `sessions.token` already is (Better Auth
  stores those unhashed), so it widens no boundary — **provided every failure path deletes the row
  and the session it stranded**. `discardChallenge` is what keeps that true; don't add an exit that
  skips it.
- **Every way of failing spends the challenge.** Wrong code past `LOGIN_CODE_MAX_ATTEMPTS`, expiry,
  and a second sign-in attempt all destroy it rather than refusing the attempt, so there is no state
  to sit on. "No such challenge", "expired" and "wrong code" are deliberately one message: telling
  them apart would confirm that a given password was good.
- **A password change forgets every device**, and so do a reset and "sign out everywhere". Ending
  the sessions while keeping the trust would leave an attacker's browser able to sign in with a
  password they later learn and never see a code. The reset path resolves its user through Better
  Auth's `verifications` row, which is internal shape rather than contract — it is best-effort by
  construction, and a failure there must stay "device not forgotten", never "reset failed".

`login_code` is the first email template with no CTA: a button inviting someone to click through
from the email would land them on a *different* device from the one waiting for the code.

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

**A tool is defined by a scope *and* an authority, and both are checked on every call**
(`mcp/registry.ts`):

| | Means | Checked against |
| --- | --- | --- |
| `access.scope` | what the operator delegated to this client at consent | the token's scopes |
| `access.permission` | what the tool does to one tenant's content | the **`mcp` column** of the approving user's role |
| `access.instance` | instance-level minimum, for users and creating/deleting sites | `users.role` |

**`access.permission` reads the `mcp` column, never the `site` one** (#151). That is the third
column's whole point: "I may delete entries; nothing acting as me may" is one edit on one role, and
it holds for every client that person ever approves — where the destructive grant below is per
client and per consent. Effective authority is `role.mcp ∩ token scopes ∩ destructive grant`, and
none of the three implies another. A **list** of permissions means all of them, for the merged tools
(`write_collection` creates *or* updates, and a caller cannot promise which half it will use).

A permission is **never** used to hide a tool, unlike a scope or the grant. It is part of a role and
a role can change between two calls on one token; `tools.listChanged` is false here, so a list
narrowed by something mutable is a list the client has no reason to refetch. The refusal arrives at
call time and names the permission, which an operator can act on.

**A third check sits in front of those two: the destructive grant** (#145). Ten tools carry
`destructiveHint` and two more opt in (`access.destructive`), and none of them runs unless the
operator allowed *this client* to delete and overwrite. Four things about it are load-bearing:

- **It is not a scope, and could not have been.** A scope is requested by the client, and no client
  that exists knows to ask for one Hedge invented — so a `destructive` scope would be missing from
  every authorization request and would refuse every delete on the day it shipped. Turning the
  question around, so the operator grants rather than the client requests, is the whole design.
- **An unrecorded grant means granted.** Every consent given before this existed has no row in
  `mcp_client_grants` and keeps working exactly as it did, the same rule `INSTALLED_BY` unset
  follows. A row is only ever written to record a decision.
- **The requirement is derived from the annotation, not declared per tool.** `isDestructive` in
  `mcp/registry.ts` reads `destructiveHint` first, so a delete added later is covered without anyone
  remembering — `registry.test.ts` pins that, because a tool that quietly escaped the grant would
  work perfectly and nothing short of an audit would notice. `access.destructive` is the explicit
  opt-in for the two that need the grant but must not claim the annotation: `upload_media` destroys
  nothing, and `update_media` overwrites with no history but should not make a client prompt a human
  before every caption fix.
- **It is recorded before the consent that depends on it.** `POST /api/v1/auth/oauth/consent` is
  ours and writes the grant, then delegates to Better Auth's `/oauth2/consent`. Better Auth's own
  endpoint takes `{accept, consent_code}` and grants the scope parked when the authorization request
  arrived, so a narrowing cannot travel through it at all. Approving first and recording second
  would leave a window holding a live token with no narrowing behind it — and since unrecorded means
  granted, that window defaults to the widest answer. Don't reorder them.

A declined grant *hides* the covered tools, on the same grounds a missing scope does: both are fixed
for the life of the consent. Calling one anyway still reports the real reason.

Neither implies the other and the narrower wins, which is what makes the surface differ per user
without any per-user configuration: the same client approved by an editor and by an owner can do
two different things. **An owner needs no special case** — `sitePermissionsFor` resolves an instance
owner or admin to every site permission on every site, so an owner passes by construction rather
than by exemption. Don't add one.

Pick the permission a new tool declares by **matching the REST route that does the same thing** —
literally the same string, now that both sides speak one vocabulary. `delete_entry` is
`entries:delete` because `DELETE /collections/:c/entries/:slug` is. A tool whose gate is looser than
its route is a hole, and that is checkable rather than a judgement.

**A tool's `structured` result is a record, never a bare array** (#114). The spec says
`structuredContent` is a JSON object, and a conforming client enforces it by *rejecting the whole
response* before the model sees any of it — so a tool that answers with an array is not degraded,
it is unusable, and nothing short of a real client notices. A list answers `{ data }`, which is what
the paginated tools already return minus `nextCursor`, so a client never has to ask which list it
is holding. `ToolResult.structured` in `mcp/registry.ts` is typed `Record<string, unknown>` to make
the wrong shape a compile error rather than a documented rule; that is also why `CreateSiteResult`
in `@hedge/core` is a type alias and not an interface.

**`tools/list` has a budget, and it is a test** (#144). Every client fetches it before it can do
anything and the whole of it lands in a model's context window, so its size is a feature with a
number on it: `schema-compact.test.ts` fails when the serialised surface passes `PAYLOAD_BUDGET`.
Two things keep it there, and both are easy to undo:

- **`compactSchema` runs on every tool's `inputSchema`** (`mcp/schema-compact.ts`). It factors the
  head a union's branches share into `$defs` and hoists whatever else repeats — the 13-kind field
  union was 37% of the payload, inlined three times, each branch restating the same five base
  properties. It changes size and nothing else, and the test proves that per tool by expanding the
  result and comparing it to what it started as, rather than by asserting it in a comment.
- **A `create_*`/`update_*` pair whose scope *and* role match is one `write_*` tool**, because
  advertising both inlines one argument schema twice. `write_collection` is the merge that paid;
  entries deliberately did **not** merge, because `slug` would have to mean both "which entry" and
  "what to call the new one", and `update_entry` already carries `newSlug` to keep those apart.

**A delete never merges into a write tool.** It carries `destructiveHint`, which is what a client
asks a human about, and #145 makes withholding deletes a grant an operator can decline — an
`action: "delete"` argument can be neither annotated nor withheld.

Descriptions are not where to find the next saving. They are what stops a tool being misused, and
the long ones are long for a reason — `create_api_key` warns that a raw secret lands in the context,
`link_translation` explains what a merge does and does not move.

Adding an area means adding a `:read`/`:write` pair to `MCP_SCOPES` **and** a line to
`MCP_SCOPE_LABELS` in `packages/core/src/auth.ts` — the consent screen renders from the labels, and
a scope with no label reaches an operator as a bare `users:write` nobody can evaluate. Nothing else
needs touching: `auth/cms.ts` and the admin's consent screen both read the list.

`tools/list` is filtered by scope; dispatch is not. An ungranted tool is `hidden` but still callable,
so calling it reports the missing scope rather than "unknown tool" — which a model reads as "the CMS
cannot do this" and works around. Role failures are never hidden; a role can change between two calls
on one token.

Two REST powers are deliberately withheld and `mcp.test.ts` pins both, and one constraint survives
from a third that was lifted:

- **Sending a newsletter to its audience.** It reaches real inboxes and cannot be recalled.
  `send_test_newsletter` mails one named address, which is what an agent actually needs.
- **Moving a whole file through the context window.** This one used to read "uploading media", and
  #143 narrowed it: uploading is exposed, base64 as the *transport* for it is not. `upload_media`
  takes a `url`, which the Worker fetches and streams into R2 through the same `storeUpload` the
  multipart route uses — the file never enters the conversation. `data` takes base64 for content
  that has no URL because the model just made it, and is capped at `MAX_INLINE_UPLOAD_BYTES`
  (1 MB, against the REST route's 25 MB) so the cheap path stays the obvious one. Fetching a
  caller-supplied URL is the deployment's only outbound request driven by caller input, so
  `lib/remote-file.ts` is where the SSRF guards live and it exports nothing else.
- **Approving, rejecting or publishing an entry version** (#62). Authoring one and submitting it for
  review are exposed; blessing one is not. The reasoning is sharper than the newsletter's: the point
  of the workflow is a second pair of *human* eyes, and an agent approving the version it has just
  written is a rubber stamp with extra steps. Say so in any new tool description that comes near it.

`list_translations`, `link_translation` and `unlink_translation` are exposed in full, which is worth
contrasting with the three above. Linking two entries changes no text, no status and no URL — it
records that two rows are one piece — and it is reversible. There is nothing in it that has to be a
human judgement rather than an automated one, and an agent tidying up a batch of separately-authored
translations is a good use of it. Their gates match the REST routes: `editor` and `entries:write`.

`create_api_key` returns a raw secret into a model's context. That is a real weakening versus the
admin's show-once dialog, so the tool description says so; keep that warning if you touch it.
