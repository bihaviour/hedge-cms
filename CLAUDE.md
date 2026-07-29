# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hedge is a headless CMS running entirely on Cloudflare Workers — one Worker serves the admin SPA,
the management API, a cached delivery API, media, and an MCP endpoint. Bun workspaces monorepo.

## Detailed rules — read the relevant file before working in that area

These are **not** loaded automatically. Read the file when the task touches its area; that keeps
this document short and the detail close to the code it governs.

| Read | Before |
| --- | --- |
| `.claude/rules/api-routes.md` | Adding or changing a Worker route: the credential-by-prefix pipeline, the two authorization levels, errors, validation, pagination, caching |
| `.claude/rules/auth.md` | Sessions, invites, members, or the MCP OAuth server: the two Better Auth instances and the policy that must not drift |
| `.claude/rules/database.md` | Touching `schema.ts` or writing a query: the migration workflow, SQLite limits, tenancy, timestamp formats |
| `.claude/rules/admin-ui.md` | Changing the React admin: the API client, active-site handling, shadcn, adding a field kind |
| `.claude/rules/workers-config.md` | Editing `wrangler.jsonc`, adding a binding, deploying, the three install paths, or anything touching a Cloudflare API token |

When something in a rule file turns out to be wrong or incomplete, fix that file — don't move the
correction into this one.

## Commands

```bash
bun run dev:api          # Worker on :8787 (wrangler dev — emulates D1, R2, assets locally)
bun run dev:admin        # Admin SPA on :5173, proxies /api and /media to :8787
bun run installer        # The no-Git installer wizard on :8976 (apps/installer)
```

Both are needed for local work; run them in separate terminals. No Cloudflare account required
locally. Emails aren't sent in development — invite and reset links print to the `dev:api` console.

```bash
bun run lint             # biome check .          (lint:fix to write)
bun run typecheck        # tsc --noEmit in every workspace
bun test                 # bun's runner, whole repo
bun test apps/api/src/lib/mcp.test.ts          # one file
bun test -t 'rejects a plain code challenge'   # one test by name
bun run build            # core typecheck → admin vite build → worker dry-run bundle
```

CI (`.github/workflows/ci.yml`) runs `cf-typegen`, then lint, typecheck, test, build. Run all four
before opening a PR — `/gh` (`.claude/skills/gh/SKILL.md`) does this and the codegen checks for you.

```bash
bun run db:generate      # drizzle-kit generate — a migration from schema.ts changes
bun run db:migrate       # apply to local D1
bun run db:migrate:remote
bun run db:seed          # apps/api/seeds/dev.sql
bun run cf-typegen       # regenerate worker-configuration.d.ts after wrangler.jsonc edits
```

First-time setup also needs `echo 'AUTH_SECRET="'$(openssl rand -base64 32)'"' > .dev.vars` at the
repository root. Nothing else: the local D1 and R2 are created on the first `dev:api`.

A `PostToolUse` hook (`.claude/hooks/check.sh`) runs `biome check --write` on every file you edit and
typechecks the owning workspace, blocking on failures. Don't reformat by hand.

## Layout

| Path | What |
| --- | --- |
| `apps/api/` | The Worker: Hono routes, Better Auth, Drizzle/D1, R2, email, MCP |
| `apps/admin/` | React 19 + Vite + Tailwind v4 SPA, built to `dist/` and served by the Worker |
| `apps/installer/` | Wizard that provisions and deploys Hedge onto a Cloudflare account with no Git repository |
| `packages/core/` | Zod schemas, wire types, roles, field kinds — imported by both sides |
| `packages/deploy/` | The Cloudflare deploy client: API client, release artifact reader, migration runner |
| `wrangler.jsonc` | The Worker's only config, at the root so the deploy button and Workers Builds find it |

`@hedge/core` and `@hedge/deploy` are consumed as source (no build step; their `build` is just a
typecheck). The admin aliases core to `packages/core/src/index.ts` in `vite.config.ts`; `@/` maps to
`apps/admin/src`.

**`packages/deploy` is imported by the Worker and by the installer; it imports neither.** That is
what keeps `apps/installer` out of the bundle serving every request. Deploy code that both need goes
there — never a second copy, and never a reach from one app into the other.

**A shape crossing the wire is defined once, in `packages/core`.** Both sides import it, so an API
change that breaks the admin fails typecheck instead of failing in a browser. Never redeclare a
request or response type in `apps/api` or `apps/admin`.

## Invariants

Details are in the rule files; these are the ones worth knowing before you read anything.

- **Credentials are separated by route prefix, in middleware** (`apps/api/src/index.ts`), so a
  delivery API key cannot reach the management API even if a route's own check is wrong. Three
  tiers: the delivery API takes any key, `KEY_MANAGED_PREFIXES` (content and media) takes a session
  or a *write-scoped* key, `ADMIN_PREFIXES` takes a session only. **A new management route must be
  added to one of the two lists** — pick `ADMIN_PREFIXES` unless a machine is meant to reach it.
- **Operators and website members are two Better Auth instances over separate tables.** A member
  token isn't rejected by the admin API, it's unresolvable there.
- **Authorization is ours, not Better Auth's** — instance role (`users.role`) and site role
  (`site_users`) are checked independently in `lib/auth.ts`.
- **`siteId` is the tenant boundary.** A content query that doesn't filter on it is a bug.
- **The Worker can redeploy itself, but never stores a Cloudflare token.** This reverses the older
  "the Worker never redeploys itself". A token carrying `Workers Scripts:Edit` is arbitrary code
  execution on the account, so it is presented per update, used inside one request, and discarded —
  never written to D1, logged, or returned. The installer answers the same question the same way, on
  the operator's own machine. Reasoning in `workers-config.md`; don't weaken it without one.
- **A deployment can exist three ways** — deploy button, installer, CLI — and they do not share an
  update path. `INSTALLED_BY` records which, and unset must keep meaning "show both". Nothing about
  how the Worker runs reads it.
- **`wrangler.jsonc` holds nothing account-specific.** The D1 and R2 bindings carry no ids —
  wrangler provisions them on first deploy — which is what lets the README's Deploy to Cloudflare
  button work on somebody else's account. Same reason `PUBLIC_URL` is empty and filled from the
  request origin.
- **An email's sender resolves site → deployment → environment**, field by field
  (`email/config.ts`). `sendEmail` takes the site an email belongs to — a newsletter, or anything
  sent to one site's member — and operator email passes none, so no site can relabel an invite or a
  password reset. The member auth callbacks get their site from the request-scoped store in
  `lib/site.ts`, because Better Auth hands them nothing else.
- **Generated files are committed, never hand-edited**: `migrations/` + `migrations/meta/` from
  `db:generate`, `worker-configuration.d.ts` from `cf-typegen`, `apps/admin/src/components/ui/` from
  the shadcn CLI (also excluded from linting).

## Style

Biome: single quotes, no semicolons, 100 columns, 2-space indent. Comments explain non-obvious
decisions, not what the code already says — the existing code is heavily commented in that style,
so match it rather than stripping or padding it.
