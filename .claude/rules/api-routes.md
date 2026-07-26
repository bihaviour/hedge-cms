# Rule: API routes (`apps/api/src/routes/`, `apps/api/src/lib/`)

Read before adding or changing a Worker route.

## Request pipeline (`apps/api/src/index.ts`)

**Which credential a route accepts is decided once, by path prefix, in middleware** — not by
handlers remembering to check. Three tiers, narrowing as authority grows:

- `/api/v1/content/*` → `resolveDeliveryActor` — **any** API key (`hdg_…`, HMAC'd with
  `AUTH_SECRET`), serving published content only
- the `KEY_MANAGED_PREFIXES` list (`/collections`, `/media`) → `resolveSessionOrKeyActor` — an admin
  session, **or** a key that carries a `:write` scope
- the `ADMIN_PREFIXES` list → `resolveSessionActor` — admin session cookie only
- `/api/v1/mcp` → resolves its own OAuth bearer token inside the route
- everything else → `actor = null`

The point is that a delivery key sitting in a public website's env has *no path* into the
management API even if a route's own authorization check is wrong. **A new management route must be
added to one of the two lists** or it will resolve no actor at all; `ADMIN_PREFIXES` is the default,
and `KEY_MANAGED_PREFIXES` only for authoring routes a machine is meant to reach.

The write-scope condition on the second tier is load-bearing, not a nicety. A `content:read`-only
key is the delivery credential; resolving it there would hand it `GET /collections/:c/entries`,
which returns **drafts** — something the delivery API deliberately never serves.

A key's role comes from its scopes (`roleForScopes` in `lib/delivery-auth.ts`): `collections:write`
→ `admin`, any other `:write` → `editor`, otherwise `viewer`. `requireRole` — instance level —
rejects API keys outright whatever that role says, so a key can never gain authority over the
deployment by way of a route added later.

Then `resolveSite` (an API key is bound to the site it was issued for, so the actor comes first),
then `resolveMember` for delivery and member routes only. All three set `null` rather than
rejecting; `requireSite` / `requireActor` do the rejecting.

Order matters at the bottom too: the hedge auth facade (`routes/auth.ts`) is mounted *before* Better
Auth's catch-all, so shared paths answer in our error format.

## Authorization — two independent levels

Both live in `lib/auth.ts`:

- **Instance** — `users.role` (`owner` > `admin` > `editor` > `viewer`), via `requireRole`. Managing
  users and sites. Owners and admins reach every site.
- **Site** — `site_users`, via `requireSiteRole`. For editors and viewers the grant *is* their
  access; their `users.role` is only the default they were invited with. `currentSiteRole` memoises
  the lookup per request.

`requireScope` layers on top for credentials that carry scopes (API keys, delegated OAuth clients);
a session actor has none, so the check passes through for people.

A typical route uses both:

```ts
app.post('/', requireSiteRole('editor'), requireScope('content:write'), async (c) => {
  const input = await validate(c, createEntrySchema)
  return c.json({ data: await createEntry(c.env, requireSite(c).id, input) }, 201)
})
```

Never hand-roll a role comparison — `roleAtLeast` from `@hedge/core` is the only ordering.

## Site resolution (`lib/site.ts`)

In order: `X-Hedge-Site` header → `?site=` → the API key's own site → `Host` against `sites.domain`
→ the only site when the deployment has exactly one. An explicit selector matching nothing is
`unknown_site` (404), never a silent fallback to another tenant — the admin client keys off that
code to forget a deleted site.

## Errors and validation

- Throw `ApiError` (`lib/errors.ts`); `app.onError` renders it. Codes and their HTTP statuses are
  defined once in `packages/core/src/api.ts` — add there, not inline.
- Response bodies are `{ data }`, `{ data, nextCursor }`, or `{ error: { code, message, details? } }`.
- Parse input with `validate(c, schema)` / `validateQuery(c, schema)` using a schema from
  `@hedge/core`. Zod failures become a 400 with per-field details keyed by dot-path.
- Shared request/response shapes belong in `packages/core`, so the Worker and the admin agree by
  construction. Don't redeclare a type in `apps/api`.

## Pagination

Keyset, not offset: the cursor is the last row's sort value, and ids are timestamp-prefixed
(`lib/id.ts`) so id order is creation order. Select `limit + 1`, slice, and return `nextCursor`.

## Rate limiting

`lib/throttle.ts` is a fixed-window limiter over the same `rate_limits` table Better Auth uses. It
exists because the member routes call Better Auth's server API directly rather than through its HTTP
handler, so the limiter attached to that handler doesn't apply. Counters live in the database on
purpose — an isolate is short-lived and there are many, so an in-memory count is a budget an
attacker resets by being routed elsewhere.

## Caching

`routes/content.ts` sets a long `s-maxage` so Cloudflare's cache absorbs public delivery traffic.
Anything unlocked by a member token, or carrying one, is `private, no-store` — gated content must
never land in a shared cache, and that is enforced by staying out of shared caches rather than by
trusting every hop to honour `Vary`.
