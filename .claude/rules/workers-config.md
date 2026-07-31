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

`REPO_URL` is deliberately **not declared here at all**. The deploy button's setup page renders
every declared var as a required field, and this one's value cannot be known before the button has
created the clone — so nobody types it: under Workers Builds, `scripts/deploy-worker.ts` derives it
from the checkout's git `origin` and injects it with `--var`, credentials stripped, because a CI
remote can embed an access token and a var is readable in the dashboard. It stays a display value:
the admin's "update available" notice (`/settings/about`) deep-links it when present and falls back
to the upstream release notes when not. A CLI deploy sets none — its origin is usually this
upstream, which would be a false claim; declare the var in your own copy if you want the link.

## Versioning and releases

The running version lives in **one** place, `HEDGE_VERSION` in `packages/core/src/version.ts`, which
the API health route, the MCP `serverInfo` and the admin all import. `GET /api/v1/system/version`
(admin-only) compares it against the latest GitHub Release of `HEDGE_REPO` — cached in the edge Cache
API, because the unauthenticated GitHub API is rate-limited per shared egress IP — and the admin
surfaces "an update is available" from that.

**The Worker can now redeploy itself** (`POST /api/v1/system/update`, issue #35). See the section
below for what that reverses and what replaced it. Merging the upstream into a button or CLI
deployment's repository (Workers Builds redeploys) remains a valid path; the dashboard update is the
one that works for every deployment, including one installed with no repository at all. Both apply
the same migrations to the same `d1_migrations` table, so they don't fight.

Cutting a release (SemVer):

1. Bump `HEDGE_VERSION` and the `version` in the root and workspace `package.json` files together.
2. Commit, tag `vX.Y.Z`, and cut a **GitHub Release** on that tag — the update check reads the
   latest non-draft, non-prerelease release, so a plain tag with no release is invisible to it.
3. The `Release artifact` workflow (`.github/workflows/release.yml`) builds `hedge-<version>.tar.gz`
   and its `.sha256` and attaches them to the release. The in-Worker updater deploys from that
   artifact, so a release without it can be *seen* by the update check but not *applied* — confirm
   the two assets are attached before announcing the release. `bun run build:artifact` reproduces
   them locally from a clean tree if the workflow needs re-running.

The check ignores drafts and prereleases, so work-in-progress tags don't nudge self-hosters.

## The reversed invariant, and the token policy that replaced it

This file used to say **"the Worker never redeploys itself"**. Issue #31 reversed it deliberately,
and the replacement is narrower and worth stating in full, because the old rule was doing real work
and something has to keep doing it.

**The Worker can redeploy itself, but only with a credential the operator presents at that moment,
and it never stores one.**

The reasoning, not just the rule. A token that can update a Worker carries `Workers Scripts:Edit`,
which is arbitrary code execution on the whole Cloudflare account. If Hedge held one at rest, then
"an attacker reached CMS admin" would become "an attacker executes arbitrary code on the Cloudflare
account" — a much larger blast radius than the CMS itself, bought for the convenience of not pasting
a token. So the token arrives in the request body, lives only in the `CloudflareClient` closure for
that one request, and is gone when it returns.

Concretely, and none of these are incidental:

- **Never persisted.** Not to D1, not to R2, not to a KV, not to a var or a secret binding.
- **Never logged**, including inside an error. `CloudflareError` carries the API's own error codes
  and nothing from the request.
- **Never returned.** `SystemUpdateResult` has no field it could travel in, which is why it reports
  per-step statuses rather than echoing anything back.
- **Never accepted from a machine.** `system:update` is owner-only and `/api/v1/system` is in
  `ADMIN_PREFIXES`, so an API key or a delegated MCP client cannot reach the route at all.
- **Rate-limited**, because a route that spends someone else's Cloudflare quota should be.

The same policy governs the installer (`apps/installer`, #38), which faces the same question from
the other end and answers it the same way: the operator's token is posted to a process on *their*
machine, used, and dropped when that process exits. It reaches no infrastructure of ours — and that
is a decision with a written reason behind it, not an accident of hosting. Spike #37
(`docs/spikes/37-browser-cloudflare-api/`) has the finding that forced it: Cloudflare's API serves no
CORS headers, so the alternative was a proxy we run, through which every operator's token would pass.

Every path is operator-initiated. Nothing self-updates on a schedule and nothing deploys without
someone presenting a credential at that moment.

## Three install paths

A deployment can exist three ways, and `wrangler.jsonc` is only directly involved in two of them.

| Path | How it deploys | Config it reads |
| --- | --- | --- |
| Deploy button | Workers Builds runs the root `deploy` script on every push | `wrangler.jsonc` |
| CLI | `bun run deploy` | `wrangler.jsonc` |
| Installer | `apps/installer` calls the Cloudflare API directly | the artifact's `hedge.json` |

The installer never reads `wrangler.jsonc` — it reads `hedge.json` from the release artifact, which
`scripts/build-artifact.ts` generates *from* `wrangler.jsonc` at release time. So a change here still
reaches an installed deployment, one release later, and the installer needs no release of its own to
learn about a new binding.

**`INSTALLED_BY` records which path made a deployment** (`button` | `installer` | `cli`), so the
admin's About page offers instructions that exist for it. Display only: nothing about how the Worker
runs reads it. Unset must keep meaning "show the dashboard update and the git fallback, claiming no
repository" — every deployment made before it existed has it unset forever.

No path asks the operator for it. The committed value is `button`, because Workers Builds deploys
the committed config verbatim and the setup page prefills the field from it; `scripts/deploy-worker.ts`
overrides it to `cli` when the deploy runs outside Workers Builds; the installer writes `installer`
itself. A hand-connected Workers Builds repository also reads `button`, which is fine — it has
exactly the button's update paths. The dashboard updater inherits the live bindings rather than
reapplying the artifact's vars, so an update never relabels a deployment.

**`WORKER_NAME` is the one var here that is functional.** A Worker is not told its own script name at
run time, and the updater has to address the script it is running as. A button or CLI deployment is
always the `name` at the top of `wrangler.jsonc`, so this stays empty for them; the installer lets
the operator choose a name and records it here. Without it, a deployment installed under any other
name could not update itself while the About page told it that it could.

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
bun run deploy                    # build → migrate the remote D1 → scripts/deploy-worker.ts
```

The last step is `wrangler deploy` wrapped by `scripts/deploy-worker.ts`, which labels the install
path: outside Workers Builds it overrides `INSTALLED_BY` to `cli`; inside, it injects `REPO_URL`
from the checkout's git origin and leaves the committed `button` standing.

Migrations run *before* the deploy, which is also what Workers Builds does when it runs the `deploy`
script for a button deployment. `d1 migrations apply` references the binding (`DB`), not the
database name, so it still finds the database when someone renames it at setup time.

Deploying is the user's call. Don't run `deploy` or `db:migrate:remote` without being asked.

## The deploy button

The button is **one** of the three install paths, not the model the rest of the project assumes. It
is the right one for someone who wants CI, preview URLs and a repository to work in — and it is the
only one that requires a Git account, which is why the installer exists. Don't write documentation or
error copy that treats a repository as a given: `apps/installer` deployments have none, and after
issue #39 the admin knows the difference and says so.

`README.md` carries a Deploy to Cloudflare button pointing at the repository root. It reads
`wrangler.jsonc` for the resources to provision, `.dev.vars.example` for the secrets to prompt for,
and the root `package.json` for the `build` and `deploy` commands and the `cloudflare.bindings`
descriptions shown on the setup page. Changing any of those four changes what someone clicking the
button gets.

The button **clones** the repository; it does not fork it. A clone has no upstream relationship, so
there is no "Sync fork" button on it — instructions that mention one are wrong, and were, until #36.
`REPO_URL` points at that clone, recorded automatically on every Workers Builds deploy.

**Three places describe a var and must stay in step**: the field descriptions in the root
`package.json`, the comments in `wrangler.jsonc`, and the README. `INSTALLED_BY` and `WORKER_NAME`
are in that set now, and the installer is a fourth reader of the second one — it fills these in
itself, from `hedge.json`, so a var whose meaning changes here has to be checked against
`apps/installer/src/install.ts` too. `scripts/deploy-worker.ts` is a fifth: it decides
`INSTALLED_BY` and `REPO_URL` at deploy time, so those two have to be checked against it as well.
