# Hedge installer

Provisions and deploys Hedge onto a Cloudflare account without a Git repository, a terminal session
you have to understand, or a `wrangler` install (#38).

```bash
bun run installer          # from the repository root
```

It serves a wizard on `http://127.0.0.1:8976` and opens it. Paste a Cloudflare API token, pick an
account, name the deployment, and it creates the D1 database, the R2 bucket, uploads the admin and
the Worker from the latest release artifact, applies the migrations and hands back the URL.

## Why there is a process here at all

Spike [#37](../../docs/spikes/37-browser-cloudflare-api/) established that `api.cloudflare.com`
returns no CORS headers, so **no browser page can call it** — not one we host, and not one you open
from your own disk (a `file://` page has an opaque origin and is checked the same way). Something
outside the browser has to make the calls.

The two ways to do that are a proxy we host, and a process you run. A proxy would mean every
operator's Cloudflare API token — carrying `Workers Scripts:Edit`, which is arbitrary code execution
on their account — passing through infrastructure we operate. This project already refuses to *store*
such a token for a smaller version of the same reason. So it runs here instead: the page is served
from loopback, your token is posted to this process, and this process calls Cloudflare. Nothing about
an install touches anything of ours except the public GitHub release it downloads.

This process binds to `127.0.0.1`, holds no state, and writes no file. Stop it and nothing remains.

## What it does, in order

| | Step | Notes |
| --- | --- | --- |
| 1 | Verify the token, list accounts | Fails here rather than half-way through |
| 2 | Check the name is free | An occupied script name would otherwise be discovered by overwriting someone's Worker |
| 3 | Download and verify the release artifact | Checksummed against the `.sha256` published beside it |
| 4 | Create the D1 database | `<name>-db`, adopted if it already exists |
| 5 | Create the R2 bucket | `<name>-media`, same |
| 6 | Apply migrations | **Before** the Worker exists, so nothing can serve an un-migrated schema |
| 7 | Upload the admin assets | Content-hashed, so a retry re-uploads only what is missing |
| 8 | Upload and deploy the Worker | Bindings built from the artifact's `hedge.json` |
| 9 | Enable the `workers.dev` subdomain | Without it the Worker answers nothing |
| 10 | Hand over the URL | Straight into `/setup` |

Steps 6–9 differ from the order in issue #38, which lists migrations last. Running them before the
Worker is routable costs nothing and means no request can reach an un-migrated schema — the ordering
rule #35 established for updates.

## Resumable, and honest about what it left behind

Every provisioning step is idempotent by name, so re-running the installer with the same name adopts
what the previous attempt created rather than making a second database the operator pays for and
cannot identify. When a run fails, the result names everything that already exists on the account and
says so on the page — a half-finished install that reports nothing is the failure mode worth
designing against.

## What it sets

`AUTH_SECRET` is **generated here** — 32 random bytes, exactly what `openssl rand -base64 32`
produces. It is written straight into the Worker's bindings, never shown, never logged, and never
returned to the page. That is the clearest single improvement over the deploy button, which asks a
non-technical operator to run `openssl` and paste the result.

Everything else comes from the artifact's `hedge.json`, so the installer never hardcodes what Hedge
needs and a future binding does not require an installer release. Four values are decided here:

- `PUBLIC_URL` — **empty, always.** The deployment answers on a generated `workers.dev` hostname,
  which is exactly what the request-origin fallback is for. A wrong value 500s every authenticated
  route while `/api/health` keeps answering `ok`.
- `REPO_URL` — empty. There is no repository.
- `INSTALLED_BY` — `installer`, so the About page offers the update path that exists for this
  deployment and never the git fallback (#39).
- `WORKER_NAME` — the script name you chose. A Worker is not told its own name at run time, and the
  dashboard updater has to address itself; without this, a deployment named anything but `hedge-cms`
  could not update itself.

## What you give up

No Git repository means no Workers Builds, no CI, no preview URLs and no redeploy on push. Updates
come from the admin, under **Settings → About & updates**, by pasting a token the same way. The
wizard says this before you install rather than leaving it to be discovered.

Email is the other caveat. The `EMAIL` binding is attached, but Cloudflare Email Sending needs a
domain onboarded with `wrangler email sending enable <domain>` before anything sends, and the
installer cannot do that. Everything else works without it.

## Layout

| File | What |
| --- | --- |
| `server.ts` | The local runner: serves the page, runs the install, streams progress as SSE |
| `src/install.ts` | The sequence itself — runtime-agnostic, driven entirely through `@hedge/deploy` |
| `src/protocol.ts` | The shapes both halves exchange, defined once |
| `src/page.ts` | The document, styles included; no external requests |
| `src/client.ts` | The page's behaviour, bundled at start-up and inlined |

`src/install.ts` takes a `CloudflareClient` and knows nothing about where it runs. If Cloudflare ever
serves CORS headers on `client/v4`, it moves into the browser and the runner is deleted; if the
project ever decides a hosted proxy is acceptable, it moves there. That reversibility is deliberate —
see the spike.

## Still to do

Distribution is the gap. Running this needs a checkout and Bun, which is a terminal — and Stage 2
exists to reach people who do not have one. The intended packaging is a single-file executable per
platform (`bun build --compile`) attached to each release, so the operator downloads one file and
opens it. That is not built yet, and it carries a real cost worth stating when it is: an unsigned
binary trips macOS Gatekeeper and Windows SmartScreen, which is friction for exactly the person this
is for.
