# Rule: Worker configuration and deploys (`apps/api/wrangler.jsonc`)

Read before editing `wrangler.jsonc`, adding a binding, or deploying.

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
| `ASSETS` | the built admin SPA at `../admin/dist` |

`AUTH_SECRET` is the only secret: Better Auth's signing key *and* the HMAC key for delivery API keys
and invite tokens. Rotating it invalidates every session, every invite link and every API key.
Local: `apps/api/.dev.vars`. Production: `wrangler secret put AUTH_SECRET --env production`.

## Assets and routing

`not_found_handling: "single-page-application"` serves the admin, with
`run_worker_first: ["/api/*", "/media/*", "/.well-known/*"]`. All three entries are load-bearing:

- `/api/*` — so a 404 returns JSON rather than being rewritten to `index.html`
- `/media/*` — the R2 passthrough
- `/.well-known/*` — OAuth discovery; without it a metadata request gets `index.html` and MCP client
  bootstrapping breaks

Every config block is duplicated under `env.production`. **Change both**, or production silently
runs different settings.

## Deploying

```bash
bunx wrangler secret put AUTH_SECRET --env production
bunx wrangler email sending enable yourdomain.com
bun run db:migrate:remote
bun run deploy                    # build, then wrangler deploy --env production
```

Set `PUBLIC_URL`, `EMAIL_FROM` and `EMAIL_FROM_NAME` under `env.production.vars` first — `PUBLIC_URL`
is what invite links, media links and the OAuth resource identifier point at.

Deploying is the user's call. Don't run `deploy` or `db:migrate:remote` without being asked.
