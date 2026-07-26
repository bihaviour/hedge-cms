# Rule: Worker configuration and deploys (`wrangler.jsonc`)

Read before editing `wrangler.jsonc`, adding a binding, or deploying.

## One config, at the repository root

`wrangler.jsonc` sits at the root, not in `apps/api`, because that is where the Deploy to Cloudflare
button and Workers Builds look for it — a monorepo subdirectory would have to be self-contained and
this one is not (`apps/api` needs `@hedge/core` and `apps/admin/dist`). Paths in it are relative to
the root: `apps/api/src/index.ts`, `apps/admin/dist`, `apps/api/migrations`.

Every wrangler command therefore runs with `--config ../../wrangler.jsonc` from `apps/api`, where
wrangler is installed. The root scripts (`dev:api`, `build`, `deploy`, `db:migrate*`, `cf-typegen`)
already do that; don't invoke wrangler from the root, it isn't installed there.

There are **no wrangler environments**. The committed config is the deployed one; local development
overrides the single value that differs, with `wrangler dev --var ENVIRONMENT:development`.

## After any edit here

`bun run cf-typegen` → `apps/api/worker-configuration.d.ts`. That file is generated: commit it,
never hand-edit it. CI regenerates it before typechecking, so a stale one fails the build.

A new binding also needs its field on `Bindings` in `apps/api/src/env.ts`.

## Bindings

| Binding | What |
| --- | --- |
| `DB` | D1 (`hedge-db`), migrations in `apps/api/migrations` |
| `MEDIA` | R2 (`hedge-media`) |
| `EMAIL` | Cloudflare Email Sending — the `from` domain must be onboarded with `wrangler email sending enable <domain>` before anything sends |
| `ASSETS` | the built admin SPA at `apps/admin/dist` |

**`DB` and `MEDIA` carry no ids on purpose.** Wrangler provisions whatever is missing on the first
`wrangler deploy`, and locally on the first `wrangler dev`, then keeps the Worker bound to it. That
is what lets someone deploy this repository into their own account without editing anything. Adding
an account-specific id back into the committed config breaks the deploy button — don't.

`AUTH_SECRET` is the only secret: Better Auth's signing key *and* the HMAC key for delivery API keys
and invite tokens. Rotating it invalidates every session, every invite link and every API key.
Local: `.dev.vars` at the root (wrangler resolves it next to the config file). Production:
`wrangler secret put AUTH_SECRET`. `.dev.vars.example` is also what the Deploy to Cloudflare setup
page reads to know which secrets to prompt for, so anything added there becomes a prompt.

`PUBLIC_URL` is deliberately empty. A deployment does not know its own URL until it has one, so
`apps/api/src/index.ts` fills it from the origin of the request being answered, in the first
middleware — before the Better Auth instances, which are built from `env` and never see a request.
A deployment with a custom domain sets the var and that wins.

That fallback is safe only because Cloudflare routes to a Worker by hostname, so the origin is
always one the deployment answers on — it is not a Host header a caller chose. Don't carry the
pattern to a runtime where that isn't true, and don't widen it to trust a forwarded-host header.

**When it is set, it has to be a full origin — scheme included, no trailing slash.**
`https://cms.example.com`, never `cms.example.com`. Better Auth is constructed from this value and
throws `Invalid base URL` on anything that isn't one, which surfaces as a 500 on *every*
authenticated route — the admin API and the login screen — while `/api/health` keeps answering `ok`
because it never touches auth. A deploy therefore looks entirely healthy while the CMS is unusable.
Both the deploy button's field description (root `package.json`) and the README say this, so keep
the three in step. When adding a custom domain, move `PUBLIC_URL` in the same commit as the
`routes` entry: they are one change.

`REPO_URL` is also deliberately empty. It is only ever a display value: when set to the fork a
deployment was created from, the admin's "update available" notice (`/settings/about`) can deep-link
that repo's *Sync fork* page. Nothing about how the Worker runs reads it, so leaving it blank costs
only the direct link — the notice still points at the upstream release notes.

## Versioning and releases

The running version lives in **one** place, `HEDGE_VERSION` in `packages/core/src/version.ts`, which
the API health route, the MCP `serverInfo` and the admin all import. `GET /api/v1/system/version`
(admin-only) compares it against the latest GitHub Release of `HEDGE_REPO` — cached in the edge Cache
API, because the unauthenticated GitHub API is rate-limited per shared egress IP — and the admin
surfaces "an update is available" from that. A deployment updates by syncing its fork, which Workers
Builds redeploys; the Worker never redeploys itself.

Cutting a release (SemVer):

1. Bump `HEDGE_VERSION` and the `version` in the root and workspace `package.json` files together.
2. Commit, tag `vX.Y.Z`, and cut a **GitHub Release** on that tag — the update check reads the
   latest non-draft, non-prerelease release, so a plain tag with no release is invisible to it.

The check ignores drafts and prereleases, so work-in-progress tags don't nudge self-hosters.

## Assets and routing

`not_found_handling: "single-page-application"` serves the admin, with
`run_worker_first: ["/api/*", "/media/*", "/.well-known/*"]`. All three entries are load-bearing:

- `/api/*` — so a 404 returns JSON rather than being rewritten to `index.html`
- `/media/*` — the R2 passthrough
- `/.well-known/*` — OAuth discovery; without it a metadata request gets `index.html` and MCP client
  bootstrapping breaks

## Deploying

```bash
bunx wrangler secret put AUTH_SECRET
bunx wrangler email sending enable yourdomain.com
bun run deploy                    # build → migrate the remote D1 → wrangler deploy
```

Migrations run *before* the deploy, which is also what Workers Builds does when it runs the `deploy`
script for a button deployment. `d1 migrations apply` references the binding (`DB`), not the
database name, so it still finds the database when someone renames it at setup time.

Deploying is the user's call. Don't run `deploy` or `db:migrate:remote` without being asked.

## The deploy button

`README.md` carries a Deploy to Cloudflare button pointing at the repository root. It reads
`wrangler.jsonc` for the resources to provision, `.dev.vars.example` for the secrets to prompt for,
and the root `package.json` for the `build` and `deploy` commands and the `cloudflare.bindings`
descriptions shown on the setup page. Changing any of those four changes what someone clicking the
button gets.
