# Spike #37 — can the installer call the Cloudflare API from the browser?

**Answer: no.** `api.cloudflare.com` returns no CORS headers, so no browser page can call it — including
a page the user opened from their own disk. Option (2) in the issue, a downloadable HTML file, does
not survive contact with the same-origin policy either.

**Decision: the installer is a static page plus a runner that executes on the user's own machine.**
No proxy hosted by us. The page never talks to `api.cloudflare.com` directly; it talks to `/cf/*` on
its own origin — `http://127.0.0.1:8976` — and the local runner forwards that to Cloudflare. The
operator's API token goes from their browser to a process on their own machine to Cloudflare, and
touches nothing of ours at any point.

## The question, and why it had to be answered first

If token-authenticated cross-origin requests were permitted, the installer could be a static page on
any host and the operator's Cloudflare API token would never leave their machine. If they were not,
the token had to transit a server — which changes the hosting, the threat model and the privacy
statement at once. That is not a thing to discover halfway through #38.

## Method, and what could not be run here

The empirical half of this spike could not be executed in the environment it was written in:
outbound access to `api.cloudflare.com` is blocked by network policy, so neither the preflight probe
nor a real browser request could be issued. Rather than assert a result that was not observed, this
spike ships the probe it would have run — `probe.ts` and `probe.html` in this directory, both
described below — so the finding can be reproduced in about two minutes against a live token.

What the finding *is* based on:

- Cloudflare's API returns no `Access-Control-Allow-Origin` on `client/v4`, which is long-standing
  and repeatedly reported — including for `user/tokens/verify` specifically, the very first call the
  installer makes ([Cloudflare Community: CORS blocking access to Cloudflare
  API](https://community.cloudflare.com/t/cors-blocking-access-to-cloudflare-api/322605)). Cloudflare
  publishes no CORS policy for `client/v4` and documents no browser-callable surface; its own
  dashboard does not call `api.cloudflare.com` cross-origin either.
- The rest follows from the CORS specification rather than from Cloudflare's behaviour, and is not
  in doubt. See the analysis below.

Treat the first bullet as the one claim to confirm with `probe.ts` before anything in #38 is
considered settled. Everything downstream of it is deduction, not observation.

## What the specification decides on its own

Three things follow from the CORS model regardless of what Cloudflare returns, and they are what
make the result total rather than endpoint-by-endpoint.

**Every installer request is preflighted.** `Authorization` is not a CORS-safelisted request header,
so it forces a preflight on every call — including the plain `GET` of token verification. There is no
subset of the flow that sneaks through as a "simple request". The issue singled out
`multipart/form-data` with a bearer JWT as the combination most likely to fail; in fact it is not
special. `multipart/form-data` *is* a safelisted `Content-Type` value, so the multipart body is not
what triggers the preflight — the `Authorization` header already did, on every other call too. The
asset upload fails for the same reason token verification fails, and no earlier or harder.

**A preflight cannot carry credentials, so no token can rescue it.** The browser sends the `OPTIONS`
without `Authorization`. If the response lacks `Access-Control-Allow-Origin`, the real request is
never sent — the failure happens before Cloudflare ever sees the token, which is why holding a
correctly-scoped token changes nothing about the outcome.

**A local file is not exempt.** This is the finding that matters most for the issue's preferred
option. A page opened from disk has an *opaque* origin: browsers send `Origin: null` and apply the
same check to the response. It would be satisfied by `Access-Control-Allow-Origin: *` or by a literal
`null`, and `api.cloudflare.com` sends neither, so a downloaded HTML file is refused exactly as a
hosted page is. Option (2) as written in the issue — "keeps the privacy property with no
infrastructure" — does not work. The *intent* behind it is still achievable, and the decision below
is how.

Per-endpoint expectations, all for the same reason:

| Call | Preflight | Why |
| --- | --- | --- |
| `GET /user/tokens/verify` | fails | `Authorization` forces a preflight; no `Access-Control-Allow-Origin` in the response |
| `POST /accounts/{id}/d1/database` | fails | same |
| `POST /accounts/{id}/r2/buckets` | fails | same |
| `POST …/workers/scripts/{name}/assets-upload-session` | fails | same |
| `POST …/workers/assets/upload?base64=true` | fails | same; the multipart body is not the cause |
| `PUT …/workers/scripts/{name}` | fails | same |

## The options, and why the chosen one

The issue listed three. The spike changes the standing of all three.

**(1) A proxy Worker we host.** Rejected. It works, and it is the least effort, and it is the one
option whose cost is paid by the user rather than by us. Every installing operator's Cloudflare API
token — carrying `Workers Scripts:Edit`, which is arbitrary code execution on their account — would
pass through infrastructure we run. This epic already refused a smaller version of exactly this
risk: `.claude/rules/workers-config.md` records that the Worker never *stores* a Cloudflare token,
because storing one turns "attacker reaches CMS admin" into "attacker executes arbitrary code on the
Cloudflare account". A proxy we host is that same trade taken at a larger blast radius — one
compromise reaching every operator who ever installed, instead of one deployment. For an MIT-licensed
project whose entire proposition is that you host it yourself, "self-hosted, except at the one moment
your credentials matter most" is not a promise worth making. It also creates an operational and
liability burden that never ends.

**(2) A downloadable HTML file.** Impossible, per the analysis above. Worth recording as impossible
rather than merely unattractive: the same-origin policy applies to `file://`, and a future reader
will otherwise reach for it again.

**(3) A `bunx` one-liner.** The issue rules this out because Stage 2 exists to reach people without a
terminal, and that objection stands. But it points at something true: once the browser cannot make
the calls, *something* on the user's machine has to, and the only question left is what that
something looks like when you double-click it.

**The decision — (2)'s intent, carried by (3)'s mechanism.** Ship the installer as a static page and
a local runner, packaged together:

- **`apps/installer`** builds a static wizard. It calls `/cf/*` **on its own origin**, so it never
  makes a cross-origin request and CORS never applies to it.
- **The runner** is a small Bun server bound to `127.0.0.1`. It serves the page and makes the
  Cloudflare calls itself, so the browser half never makes a cross-origin request at all and CORS
  never enters into it. It holds no state, writes no file, and exits when the install finishes.
- **Distribution should be a compiled single-file executable** attached to each release, one per
  platform, built with `bun build --compile`: the user downloads one file, opens it, and their
  browser opens on the wizard.

This keeps the property the issue was protecting — the token never reaches us — at no infrastructure
cost and no ongoing cost to operate.

**Status.** The installer and its runner are built (`bun run installer`, `apps/installer`). The
compiled binaries are **not** — so what ships today still needs a checkout and Bun, which is to say a
terminal, which is to say Stage 2's premise is not yet met by the packaging. That is the remaining
work, and it is packaging rather than design: `src/install.ts` neither knows nor cares what is
hosting it.

**What that packaging will cost, stated plainly.** A downloaded executable is not free of friction:
it is unsigned, so macOS Gatekeeper and Windows SmartScreen will both interrupt the user, and getting
past that is a right-click-Open or a "more info → run anyway". That is a real tax on exactly the
non-technical user Stage 2 is for, and it is the price of not routing their credentials through us.
It should be said on the download page rather than discovered at the warning dialog. Per-platform
binaries also add build surface to the release workflow, and belong in a separate job so a failure
there cannot affect the update artifact the tarball job produces.

**The decision is reversible, deliberately.** The page's API base is a single constant. If Cloudflare
ever serves CORS headers on `client/v4`, delete the runner and host the page — the wizard is
unchanged. If the project later decides a hosted proxy is acceptable after all, point the same
constant at it. Nothing else in #38 depends on which of the three is in front of it, which is the
property worth having given that the load-bearing observation is one this environment could not make.

## Reproducing the finding

Two probes, because they answer different halves and the issue asked for both.

**`probe.ts`** — what the server returns. Issues the `OPTIONS` preflight for all six endpoints and
prints the CORS headers on each response. No browser and no token needed: a preflight carries no
credentials, which is the whole point. This is the one to run first; it is decisive on its own.

```bash
bun docs/spikes/37-browser-cloudflare-api/probe.ts
```

**`probe.html`** — what a browser actually does. Runs the same six calls through `fetch` from
whatever origin the page is loaded from, and reports each as allowed or blocked. Open it two ways,
since they are different origins and the issue asks about both:

```bash
# a real http origin
bunx serve docs/spikes/37-browser-cloudflare-api    # then open the printed URL

# an opaque (file://) origin — option (2)'s premise
open docs/spikes/37-browser-cloudflare-api/probe.html
```

It takes an account id and a token so it can attempt the real requests, not just preflights. Use a
throwaway token, and delete it afterwards. If the probes ever disagree with this document, the probes
are right and this document needs correcting.
