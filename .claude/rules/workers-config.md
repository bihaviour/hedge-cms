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

## The one cron trigger

`triggers.crons` runs a single daily job, and the Worker's default export is
`{ fetch, scheduled }` rather than the Hono app because of it. It prunes website-analytics rollups
past `ANALYTICS_RETENTION_DAYS` (400): D1 has no TTL, so without it that table is the only thing in
the deployment that grows forever.

It carries no account-specific value, so the deploy button is unaffected — a cron expression is the
same on everybody's account.

**This is not a general background-work hook.** Nothing else in this deployment self-schedules:
updates and deploys are operator-initiated, for the reason in the token-policy section below. A
second cron job means meeting that argument first, in the commit message.

**`wrangler dev --test-scheduled` does not work here, and that is not a bug in the handler.** It
exposes `/__scheduled`, but the assets binding answers that path first — `run_worker_first` covers
only `/api/*`, `/media/*` and `/.well-known/*`, so `not_found_handling` returns `index.html` and the
handler never runs. Adding `/__scheduled` to `run_worker_first` to make a dev affordance work would
put a dev-only path in the production config; don't. A real cron event invokes `scheduled` directly
and never touches the asset router. `analytics-prune.test.ts` covers what the job actually deletes.

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

**It reads a *page* of releases, not `/releases/latest`, and carries their notes.** "0.0.13 is
available" is not something an operator can act on; what it changes is, so the About page renders the
changelog from the same response and a deployment several releases behind sees every one it has
missed. One call answers both questions, which is what keeps the changelog free against the rate
limit the cache exists to protect. Two consequences worth knowing:

- **Release notes are operator-facing copy in the dashboard**, not just a GitHub page. They are
  rendered by a deliberately small Markdown reader in the admin (`lib/release-notes.ts`) that turns
  a body into React elements and never into markup — a release body is written upstream, and an
  `<a href="javascript:…">` in one would otherwise be somebody else's code in an admin session.
  It covers headings, lists, `code`, bold, and links; anything else degrades to the text it was
  written as.
- **The response is bounded on the server** (`RELEASE_COUNT`, `NOTES_MAX_CHARS`), because the update
  banner shares this query and it therefore rides along on every admin page load. A body past the cap
  is cut at a line break and flagged `truncated`, which the admin shows as a link to the rest.

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
4. If the template has landed in `cloudflare/templates`, regenerate and re-submit it:
   `bun run build:template -- --install`, then the sequence in `docs/cloudflare-template.md`. Their
   `templates.json` records a `package_json_hash` per template and their CI deploys live demos, so a
   copy that stops matching this repository is a bad advert running under Cloudflare's name. The
   generator is what makes this a step rather than a project.

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

## The generated Cloudflare template — a fourth install shape, and a fourth reader of these vars

`scripts/build-template.ts` writes `hedge-cms-template/`: a flattened, npm-installable copy of this
repository for submission to [`cloudflare/templates`](https://github.com/cloudflare/templates)
(epic #54). It is **generated, never hand-maintained** — the same argument the release artifact makes.
It is not a fourth *install path*: a deployment made from the gallery is a Workers Builds clone and
carries `INSTALLED_BY: "button"`, which is exactly true of it. The runbook is
`docs/cloudflare-template.md`.

**`WORKER_NAME` is set to `hedge-cms-template` there, and the reason is the whole of it** (#49).
Their linter forces `wrangler.name`, `package.json` `name` and the directory to be the same string,
so a gallery deployment's script is called `hedge-cms-template` rather than `hedge-cms`. Leaving
`WORKER_NAME` empty is what tells the dashboard updater "I am the `name` at the top of
`wrangler.jsonc`" — which would be a lie in a copy whose name their CI chose, and would make
Settings → About offer an update that addressed a script that does not exist. The alternative — make
the updater fall back to the running script name — is not available: the runtime is not told its own
name, which is why this var exists at all. So the template sets it, at no cost, and About stays
truthful for anyone who deploys from the gallery.

That makes the generator the **fourth** reader of the three-places-must-agree rule below, and the
place where the agreement is enforced: `TEMPLATE_BINDING_OVERRIDES` in `scripts/template-lib.ts`
rewrites the `WORKER_NAME` description, because the root `package.json`'s "leave empty, a button
deployment is always `hedge-cms`" stops being true the moment the copy is renamed.

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
`scripts/template-lib.ts` is a sixth, for the generated Cloudflare template — it carries the copy
that has to differ there, and `scripts/template-lib.test.ts` fails if it stops differing.
