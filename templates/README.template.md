# Hedge CMS

<!-- The block below is lifted verbatim onto the Template Details Page in the Cloudflare dashboard.
     Keep it free of shell commands, bootstrap steps and images — CONTRIBUTING.md excludes all
     three, and the linter only checks that the markers appear once each, in order. -->

<!-- dash-content-start -->

A multi-site headless CMS that runs entirely on Cloudflare Workers. One Worker serves the admin
single-page app, the management API, a cached delivery API, media, and an MCP endpoint — there is no
origin server, no container and no second host.

**Bindings.** [D1](https://developers.cloudflare.com/d1/) holds sites, users, collections, entries
and members. [R2](https://developers.cloudflare.com/r2/) holds uploaded media, served through the
Worker so files stay behind the deployment's own URL.
[Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email/) delivers
invites, password resets and newsletters. Workers Assets serves the admin app straight from the
edge, with the Worker taking `/api/*`, `/media/*` and `/.well-known/*` ahead of it. A daily cron
trigger prunes analytics rollups past their retention window.

**Frameworks.** [Hono](https://hono.dev/) for routing, [Drizzle ORM](https://orm.drizzle.team/) over
D1, [Better Auth](https://better-auth.com/) for sessions and the OAuth 2.1 server, React 19 with
Vite, Tailwind CSS v4 and shadcn/ui for the admin, and Zod schemas shared by both sides so an API
change that breaks the admin fails the typecheck rather than the browser.

**What it does.** You model content as collections of typed fields — text, rich text, media,
references, dates, booleans, selects, and a generated code field the CMS assigns itself. Entries are
drafted, revised and published per language: a post is a translation group rather than a slug, so
every language can have a URL in its own language, and the delivery API never shows a hole — it
serves the language you asked for, falls back to the site default, and tells you which it gave you.

Reading is separate from writing. The delivery API is a cached, read-only surface a website consumes
with a scoped API key, and its `s-maxage` means Cloudflare's cache absorbs reader traffic rather than
the Worker. Content that should not be public can be gated behind website members, who sign in
against a second, entirely separate auth instance — a member token is not merely rejected by the
admin API, it is unresolvable there.

Editorial workflow is optional and off by default. Turn on approval levels for a collection and
publishing stops being a field and becomes a step: an entry version somebody other than its author
approved. Machines are deliberately excluded from that step, even when they may author the version.

The same CMS is also an MCP server. An AI assistant can connect over OAuth 2.1 and read or write
collections, entries, media, newsletters and subscribers — limited twice, by the scopes granted at
consent and by the approving user's own role, so the same client approved by an editor and by an
owner can do two different things.

Multi-tenancy is built in: one deployment hosts many sites, each with its own content, media,
members, API keys and locales, and roles are granted per site as well as instance-wide.

<!-- dash-content-end -->

## Getting started

```sh
npm install
```

Create a `.dev.vars` file with a signing secret. `AUTH_SECRET` signs sessions and invite links and
is the HMAC key for delivery API keys, so use a real random value:

```sh
echo "AUTH_SECRET=$(openssl rand -base64 32)" > .dev.vars
```

Then start it:

```sh
npm run dev
```

That applies the D1 migrations locally, builds the admin app, and serves the whole CMS from
`wrangler dev` on <http://localhost:5173>. There is no separate frontend process — in a deployment
the Worker serves the admin from its assets binding, and running it the same way locally means what
you see is what deploys.

The first visit lands on a setup wizard, because a fresh database has no owner. Give it an email
address and a password and it creates the first operator account, a site, and signs you in. From
there, create a collection, add fields to it, and write an entry.

Email is not sent in development: invite and password-reset links are printed to the `wrangler dev`
console instead.

## Deploying

```sh
npm run deploy
```

Wrangler provisions the D1 database and R2 bucket on the first deploy, applies the migrations, and
uploads the Worker. Set the signing secret once:

```sh
npx wrangler secret put AUTH_SECRET
```

Sending email is optional and does not block a deploy — nothing sends until you onboard a domain:

```sh
npx wrangler email sending enable yourdomain.com
```

Then set `EMAIL_FROM` to an address on that domain, either in `wrangler.jsonc` or in the admin under
**Settings → Email**. Until one of the two is set, invites and newsletters are composed and logged
but never handed to the provider.

If you put the deployment on a custom domain, set `PUBLIC_URL` to the full origin — `https://cms.example.com`,
with the scheme and no trailing slash. Leave it empty otherwise: the Worker then uses the origin of
whatever request it is answering, which is correct for the generated `workers.dev` subdomain.

## Live preview

A running deployment of this template is at <https://hedge-cms-template.baita.workers.dev>.

Cloudflare's convention for a published template is
`https://hedge-cms-template.templates.workers.dev`, which only exists once the template is published
— so this link points at our own deployment for now and is the reviewer's to swap.

## Screenshot

![The Hedge admin, showing an entry being edited](https://raw.githubusercontent.com/bihaviour/hedge-cms/main/docs/images/admin.png)

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/hedge-cms-template)

## Upstream

This template is generated from [bihaviour/hedge-cms](https://github.com/bihaviour/hedge-cms) by
`bun run build:template`, so it tracks releases rather than being maintained separately. Issues and
pull requests belong upstream. Licensed MIT.
