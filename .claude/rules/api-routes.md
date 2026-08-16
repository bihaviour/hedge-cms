# Rule: API routes (`apps/api/src/routes/`, `apps/api/src/lib/`)

Read before adding or changing a Worker route.

## Request pipeline (`apps/api/src/index.ts`)

**Which credential a route accepts is decided once, by path prefix, in middleware** — not by
handlers remembering to check. Three tiers, narrowing as authority grows:

- `/api/v1/content/*` → `resolveDeliveryActor` — **any** API key (`hdg_…`, HMAC'd with
  `AUTH_SECRET`), serving published content only
- the `KEY_MANAGED_PREFIXES` list (`/collections`, `/media`, `/member-sessions`) →
  `resolveSessionOrKeyActor` — an admin session, **or** a key that carries a `:write` scope or
  `members:session`
- the `ADMIN_PREFIXES` list → `resolveSessionActor` — admin session cookie only
- `/api/v1/mcp` → resolves its own OAuth bearer token inside the route
- everything else → `actor = null`

`/api/v1/collect` is in that last group deliberately, and it is the reason to keep the group. It is
the analytics collector: a public, unauthenticated write path a reader's browser posts to
(`routes/collect.ts`), and it is *not* under `/api/v1/analytics`, which is a management surface in
`ADMIN_PREFIXES`. Putting a public writer and an admin reader under one prefix means special-casing
inside the middleware whose entire value is that it does not special-case. `/api/v1/newsletter`
versus `/api/v1/newsletters` is the existing precedent for the split; follow it rather than widening
a prefix.

The point is that a delivery key sitting in a public website's env has *no path* into the
management API even if a route's own authorization check is wrong. **A new management route must be
added to one of the two lists** or it will resolve no actor at all; `ADMIN_PREFIXES` is the default,
and `KEY_MANAGED_PREFIXES` only for authoring routes a machine is meant to reach.

The scope condition on the second tier is load-bearing, not a nicety. A `content:read`-only key is
the delivery credential; resolving it there would hand it `GET /collections/:c/entries`, which
returns **drafts** — something the delivery API deliberately never serves. `members:session` writes
nothing and still passes the condition, because what it excludes is that delivery credential rather
than every key that does not author: a key holding it belongs to a site's own backend, and the mint
route lives on this tier (see `auth.md`).

**A prefix decides what is *resolved*, not what is *allowed*.** `/api/v1/member-sessions` resolves
any acting key, and the mint route inside it carries `requireScope('members:session')` so an
authoring key that reaches the tier for content and media cannot sign a reader in by living next
door. The entry-version routes
(`routes/entry-versions.ts`, #62) sit under `/collections`, so a write-scoped key resolves on all of
them — right for authoring a version, wrong for approving one. The approve, reject and publish
handlers therefore carry `requireUserActor` themselves rather than trusting where they live, and a
test pins it. When a route inside an existing prefix needs a narrower credential than the prefix
grants, say so in the route; do not move the whole prefix.

**A key may do what its scopes are for, bounded by what its issuer's role delegates to keys**
(#156, `apiKeyPermissions` in `lib/auth.ts`). The scope half is a fixed mapping in code
(`roleForScopes` in `lib/delivery-auth.ts`): `collections:write` → `admin`, any other `:write` →
`editor`, otherwise `viewer`. The issuer half is the `apiKey` column of the role held by
`api_keys.created_by`, read **live**, so narrowing a role narrows the keys its holders issued with
nothing to reissue.

**A key with no issuer is bounded by its scopes alone** — the column is `on delete set null` and
every key predating #151 has none, so unrecorded means ungoverned, the rule `INSTALLED_BY` unset
already follows. The corollary is worth knowing before it is discovered: deleting a user *widens*
the keys they issued, back to the bound the deployment ran on until that epic.

`requirePermission` — instance level — rejects API keys outright whatever any of this says, so a key
can never gain authority over the deployment by way of a route added later.

Then `resolveSite` (an API key is bound to the site it was issued for, so the actor comes first),
then `resolveMember` for delivery and member routes only, then `resolvePreview` for delivery routes
only. All of them set `null` rather than rejecting; `requireSite` / `requireActor` do the rejecting.

## Preview tokens (`lib/preview.ts`)

The fourth credential type, and it obeys the same separation-by-prefix rule as the other three —
`resolvePreview` runs on `/api/v1/content/*` and nowhere else, so a token that unlocks a draft can
never be presented at a management route. It is stateless: base64url claims signed with
`AUTH_SECRET`, the construction delivery keys and invite tokens already use.

Three things about it are load-bearing:

- **It is not a credential on its own.** It sets `preview`, never `actor`. A preview request still
  needs the site's delivery key to resolve an actor at all; the token only widens what that key may
  see, for one entry.
- **It names one entry, not a site.** `resolvePreview` checks the token's site against the resolved
  tenant, and `previewFor(c, collection, slug, locale)` checks the entry — a token that matched a
  *site* would, pasted into a public page or leaked in a referrer, expose the whole draft pipeline.
  Only the single-entry delivery handler honours one; list endpoints deliberately do not.
- **Minting is `requireUserActor`.** `POST /collections/:c/entries/:slug/preview-token` sits under
  `KEY_MANAGED_PREFIXES`, so a write-scoped key resolves on that prefix and the route has to refuse
  it explicitly. "Only a signed-in CMS user can produce a link to unpublished content" is the whole
  requirement, and that call is where it lives.

Every preview response is `private, no-store` with the header in `vary`, for the reason member-gated
content already is: correctness cannot depend on every hop honouring `Vary`.

Order matters at the bottom too: the hedge auth facade (`routes/auth.ts`) is mounted *before* Better
Auth's catch-all, so shared paths answer in our error format.

## Authorization — two independent levels

Both live in `lib/auth.ts`, and **only one of them is a rank**:

- **Instance** — a permission set carried by `users.role`, via `requirePermission`. Managing users,
  sites, email and roles. `sites:access_all` is what makes an owner or admin reach every site.
- **Site** — a permission set resolved per (user, site), via `requireSitePermission`. For editors
  and viewers the `site_users` grant *is* their access; their `users.role` is only the default they
  were invited with. `currentSitePermissions` memoises the lookup per request.

**A site route names the verb it needs, not a role that happens to include it** (#151). Deleting an
entry and updating one were one power because they were one role, and "may write, may not delete"
could not be said at all — of a person, an agent, or a machine. `requireSiteRole` and the site-level
use of `roleAtLeast` are gone; `roleAtLeast` remains for the *instance* ordering only.

`requireScope` layers on top for credentials that carry scopes (API keys, delegated OAuth clients);
a session actor has none, so the check passes through for people.

A typical route uses both:

```ts
app.post('/', requireSitePermission('entries:create'), requireScope('content:write'), async (c) => {
  const input = await validate(c, createEntrySchema)
  return c.json({ data: await createEntry(c.env, requireSite(c).id, input) }, 201)
})
```

Two consequences worth knowing before adding a route:

- **Pick the permission by what the route does, not by who does it today.** The mapping is in the
  audit table on #151; `entries:read` covers revisions and translations because reading them is
  reading the entry, and a version's create/update/delete are all `entries:update` because a version
  is a proposal to change one entry. Approve, reject and publish keep `requireUserActor` and the
  approval level on top — a permission never buys the right to bless a version (#59).
- **A mounted `app.use('*', …)` gate cannot express a matrix**, so `api-keys.ts` and
  `newsletter-templates.ts` lost theirs: reading which keys exist and issuing one are different
  verbs, and one mount can only ask for the wider of the two.

`GET /api/v1/access` is the one site route with **no** permission gate, deliberately: asking what
you may do is not one of the things you may do, and a role that grants nothing still has to be able
to learn that. Reaching the site at all is its whole requirement.

## Site resolution (`lib/site.ts`)

In order: `X-Hedge-Site` header → `?site=` → the API key's own site → `Host` against `sites.domain`
→ the only site when the deployment has exactly one. An explicit selector matching nothing is
`unknown_site` (404), never a silent fallback to another tenant — the admin client keys off that
code to forget a deleted site.

## Errors and validation

- Throw `ApiError` (`lib/errors.ts`); `app.onError` renders it. Codes and their HTTP statuses are
  defined once in `packages/core/src/api.ts` — add there, not inline. A code earns its own entry when
  a *client* acts on it differently: `unknown_site` makes the admin forget a deleted site,
  `approval_required` makes it point an author at the version route. Otherwise use `conflict`.
- Response bodies are `{ data }`, `{ data, nextCursor }`, or `{ error: { code, message, details? } }`.
- Parse input with `validate(c, schema)` / `validateQuery(c, schema)` using a schema from
  `@hedge/core`. Zod failures become a 400 with per-field details keyed by dot-path.
- Shared request/response shapes belong in `packages/core`, so the Worker and the admin agree by
  construction. Don't redeclare a type in `apps/api`.

## Pagination

Keyset, not offset: the cursor is the last row's sort value, and ids are timestamp-prefixed
(`lib/id.ts`) so id order is creation order. Select `limit + 1`, slice, and return `nextCursor`.

**The page envelope is `Paginated<T>` in `@hedge/core`** — return that, don't re-declare
`{ data, nextCursor }` inline. Every list helper used to, which is exactly the duplication the
"a shape crossing the wire is defined once" rule exists to stop. It is a *type alias and not an
interface* on purpose: an interface has no index signature, so it fails `ToolResult.structured`'s
`Record<string, unknown>` and every MCP list tool answering with a page stops compiling.

**`total` is a `COUNT(*)` over the filters *without* the cursor** (#123). The cursor narrows the
page; the count is how many rows the filters match, so a management list builds `filters` once, adds
the cursor into a separate `pageFilters`, and runs both queries in one `Promise.all`. A count that
inherits the cursor reads "of 5" on the last page of a hundred rows — plausible enough that nobody
reports it.

Two lists deliberately send **no** `total`, and both absences are load-bearing rather than pending
work:

- **The review queue.** "Waiting on you" is decided by `canDecide` in JS from the recorded decisions
  and the version's author — not a predicate a `WHERE` can hold. `countReviewQueue` is capped at 100
  for the sidebar badge for that reason, and a number that stops at 100 must never be rendered as a
  denominator. `total` is optional so the admin can tell "137" from "no exact answer" and show a
  page number instead.
- **The delivery API.** `/api/v1/content/*` is the cached public path; a second query per request
  spends the budget the `s-maxage` exists to protect, for something no reader renders.

## Rate limiting

`lib/throttle.ts` is a fixed-window limiter over the same `rate_limits` table Better Auth uses. It
exists because the member routes call Better Auth's server API directly rather than through its HTTP
handler, so the limiter attached to that handler doesn't apply. Counters live in the database on
purpose — an isolate is short-lived and there are many, so an in-memory count is a budget an
attacker resets by being routed elsewhere.

## Security headers (`lib/security-headers.ts`)

`secureHeaders` is mounted **once**, through a path-aware wrapper, and that is not a style choice.
It writes its headers after `await next()`, on the way back out, so the outermost instance wins: a
second one scoped to a narrower path, or a header set in the route handler, is silently overwritten
by the global mount. A path that needs a different policy has to be chosen inside the single
instance that will do the writing.

**Two paths get `Cross-Origin-Resource-Policy: cross-origin`** — the public media passthrough
(`/media/*`, not `/api/v1/media`) and the analytics beacon script (`GET /api/v1/collect/script.js`).
Both are fetched by a website on another origin *and read*: an `<img>`, and a `<script src>`. Those
are `no-cors` requests, the one kind CORP is checked on, so the CORS headers on the delivery API do
nothing for either.

**The failure mode is the point: under `same-origin` neither reports an error you would find.** The
browser makes the request, gets a 200 of the right content type, and discards the bytes — no 404, no
CSP violation, no console error, no failed request in the network panel. A blank image, or a tracker
script that downloads and never executes. `curl` ignores CORP entirely and a CORS `fetch()` is not
subject to it, so **every check short of a real browser passes while the feature is dead**. That is
how #104 shipped, reporting zero traffic on every site running the snippet.

`POST /api/v1/collect` is the one to *not* widen, and it looks like it belongs. CORP genuinely
applies to it — `sendBeacon` posts in `no-cors` mode — but only to a `204` the script never reads,
and the Worker records the event before the browser refuses the response, so the write lands anyway.
Widening it would loosen the deployment's only unauthenticated write endpoint to buy nothing. The
accepted cost is an `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` line in the reader's console per beacon —
noise, not a symptom, and `docs/website-analytics.md` says so, so it is not re-diagnosed as this bug.

The carve-out is by **exact path** (except `/media/*`), so it cannot creep onto a route added under
`/api/v1/collect/` later. `security-headers.test.ts` pins all of it.

**CORP is not the only header that silently breaks an embed.** `publicAssetHeaders` overrides CORP
and inherits the rest of Hono's defaults, including `X-Frame-Options: SAMEORIGIN` — so a cross-origin
`<iframe src=".../media/whitepaper.pdf">` is blocked and presents the same way, as a blank embed with
no error. That is correct today (the website only links PDFs), but check XFO as well as CORP before
concluding a `/media` embed should work.

A newsletter open-tracking pixel would join the carve-out list and would fail identically — an
`<img>` loaded cross-origin in webmail. Nothing tracks opens today (#74 decided against it); carve it
out when it is added, not after someone spends a day wondering why open rates are zero.

Purging the CDN is part of shipping a change here: media is served `max-age=31536000, immutable` and
the tracker script `s-maxage=86400`, so a bad response outlives the deploy in Cloudflare's cache and
in every visitor's browser.

## Locale fallback on the delivery API

**A reader is never shown a hole.** A published post is served in the language asked for, else the
site's `defaultLocale`, else whatever language it does have — on the single-entry read *and* in the
list. Half-translating a site therefore changes which language its index is in, never how many
entries it has.

Both handlers share `onePerTranslationGroup` in `lib/entry-query.ts`, a correlated
`id = (select … order by … limit 1)` rather than a `GROUP BY`, because the preference is an ordering
and the chosen row has to survive the outer query's sort, cursor and field filters. Four things
about the behaviour are load-bearing:

- **`publishedOnly` is applied inside the subquery as well as outside it.** A draft Indonesian
  variant must not win the pick and then be filtered away — that drops the post from the listing
  instead of falling back to its published English one. A test pins exactly this.
- **`locale` on the response is always the language of the text in it**, never the one requested.
  A caller renders `lang="…"` from it. `localeFallback` is the separate flag saying they differ.
- **A slug that belongs to exactly one language is itself a request for that language.**
  `GET /content/posts/halo-dunia` with no `?locale=` serves Indonesian, not the site default —
  answering an Indonesian URL with English text would be the one clearly wrong answer. A slug
  several languages share is ambiguous and defers to the default, exactly as it did before.
- **`alternates` is published-only**, and deliberately not the management `loadTranslations`, which
  includes drafts. A draft translation's slug is unpublished content; emitting it would hand every
  reader the URL of a page nobody has approved.

**Preview is exempt, on purpose.** `previewFor` still matches one exact (collection, slug, locale)
and that row is served or nothing is. The point of a preview is to see the draft you are holding;
quietly serving its published sibling instead is the answer that cannot be right.

The management list keeps a row per translation by default and collapses only on
`?groupBy=post` — collapsing changes what a page *counts*, and callers sweeping every row (the MCP
list tool, the admin's field-suggestion query) need them all.

## Caching

`routes/content.ts` sets a long `s-maxage` so Cloudflare's cache absorbs public delivery traffic.
Anything unlocked by a member token, or carrying one, is `private, no-store` — gated content must
never land in a shared cache, and that is enforced by staying out of shared caches rather than by
trusting every hop to honour `Vary`.

That `s-maxage` is also why the Worker cannot see website traffic and why `/api/v1/collect` exists.
Don't weaken it to make a metric work: the cache absorbing delivery traffic is the point, and the
beacon is a separate path precisely so both can be true. `routes/analytics.ts` is the other end of
the same reasoning — per-session management data, so `private, no-store` and no `s-maxage` at all.
