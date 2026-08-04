# Rule: Admin SPA (`apps/admin/`)

Read before changing the React admin.

React 19 + Vite + Tailwind v4 + shadcn/ui, TanStack Query for server state, react-router for
routing, react-hook-form + zod for forms, sonner for toasts. Built to `dist/` and served by the
Worker's `ASSETS` binding — there is no separate host.

## Talking to the API

Every call goes through `src/lib/api.ts`. Add a method there rather than calling `fetch` from a
component; it unwraps `{ data }`, preserves `nextCursor` for paginated lists, and turns error bodies
into `ApiClientError` with `code` and field `details`.

`send()` attaches the active site header to every request, and has one piece of recovery logic worth
knowing: a 404 with code `unknown_site` means the remembered site was deleted, so it clears the
stored slug and retries once. Without that, the session check itself fails and a perfectly
signed-in user sees the login screen with no way out but clearing site data.

The active site (`src/lib/active-site.ts`) is deliberately **outside React** — `lib/api.ts` reads it
synchronously while building headers — and mirrored to `localStorage`. Subscribe via
`subscribeToActiveSite` / the `useSite` hooks; don't read `localStorage` directly.

## Conventions

- `@/` aliases `apps/admin/src`. `@hedge/core` resolves to the package *source*, so shared types and
  zod schemas are imported directly — never redeclare an API shape locally.
- `src/components/ui/` is shadcn CLI output, **excluded from linting**. Regenerate with the CLI
  rather than patching by hand.
- Pages live in `src/pages/`, one per route, wired in `src/App.tsx`. Routing there is gated in three
  stages: setup-required → signed-out (token flows and `/login` stay reachable, and the query string
  must survive, because an MCP authorization request is carried in it) → the authenticated shell.
- Role gating in the UI uses `roleAtLeast` from `@hedge/core` — the same ordering the API enforces.
  UI gating is cosmetic; the server check is the real one, and both must exist. The same goes for
  approval authority: the version panel mirrors what `decideEntryVersion` would allow, so it never
  offers a button that 403s, but the server is what makes it true.
- **Two authority levels, two sources.** Instance powers are on the session: `user.permissions`
  from `useSession`, a set-membership check (the sidebar gates on it). **Site** powers are not —
  the same person can be an admin on one site and a viewer on the next, so they come from
  `useSiteAuthority` / `useHasSiteRole` in `hooks/use-site.ts`, one `GET /api/v1/access` per site,
  keyed on the active slug. A control whose route carries `requireSiteRole` is gated with the
  second, never with `user.role` — that field is only the default someone was invited with, and
  reading it would hide controls the server would allow and show ones it would refuse.
- **Both catalogs, always.** `catalog.test.ts` fails when an English key has no Indonesian
  translation, or when the two disagree on `{placeholders}`. A key present in one and missing from
  the other degrades silently to English and can sit unnoticed for a release, which is why it is a
  test rather than a habit.

## Uploading media

Several files at once, from two places — the media library and the picker — and both drive the
same queue (`lib/uploads.ts`, bound to React by `hooks/use-media-uploads.ts`, rendered by
`components/upload-queue.tsx`). Three things about it are load-bearing:

- **One file per request.** `POST /api/v1/media` takes one file and is unchanged; many files is
  many calls, at `UPLOAD_CONCURRENCY`. A single multipart body would upload as one thing — one
  progress number, and one refused file taking the batch with it — and the route streams each body
  straight into R2, so it cannot half-succeed usefully.
- **`api.media.upload` is the one call that uses `XMLHttpRequest`.** `fetch` reports nothing about
  a request body going out, and per-file progress is most of the point. It mirrors `send`'s
  unknown-site recovery by hand; if that recovery changes, change both.
- **A file refused in the browser counts as a failure of the batch it arrived with.**
  `uploadRejection` answers with the same inputs the route uses, so the two agree; leaving those
  files out of the tally reported a batch as clean and let the caller clear the row saying why a
  file is missing. `uploads.test.ts` pins it.

## Local development

`bun run dev:admin` serves :5173 and proxies `/api` and `/media` to the Worker on :8787, so the SPA
talks to a real API. `bun run dev:api` must be running too.

## Charts

Recharts is the one charting dependency, and it is 400 KB. It is confined to
`src/components/chart-marks.tsx`, which is reached **only** through the `lazy()` boundaries in
`src/components/charts.tsx` — the admin bundle is served from the Worker's `ASSETS` binding on every
cold load, and a charting library has no business being in it for somebody editing an entry. Import
recharts anywhere else and it lands in the main chunk; `bun run build` will show it.

These live in `src/components/` rather than `src/components/ui/` on purpose: that directory is
shadcn CLI output, and hand-writing a file there claims a provenance it does not have.

Series colours are the `--chart-*` tokens in `index.css`, with separate light and dark steps. They
were validated rather than chosen — lightness band, chroma floor, colour-vision separation and 3:1
contrast against both surfaces — and the reasoning is in the comment beside them. The green/red pair
sits in the CVD floor band, which is only legal alongside a second encoding, so wherever those two
appear together the meaning is also carried by position and a signed label. Re-validate before
changing a value.

Two conventions the charts share: never a dual y-axis (two measures of different scale get two
charts), and the previous period is drawn as a recessive dashed line in the muted text colour rather
than a second series — it is a reference, not a rival.

## Translations in the editor

A post's languages come from `GET .../entries/:slug/translations`, which takes **no locale** — the
editor asks it while looking at a language the post may not have yet, so a (slug, locale) lookup
would 404 exactly when the answer is needed. Two things follow, and both are easy to undo by
accident:

- **The locale switcher navigates by the sibling's own slug**, not the current one. Translations can
  have URLs in their own language, so keeping this entry's slug would open a different post.
- **Creating a translation sends `translationOf`.** Without it the link rests on the two sharing a
  slug, and the moment somebody gives the translation a localized URL it silently becomes a separate
  post instead.

The entry list uses `groupBy=post` on a multilingual site only — one line per piece with its
languages beside it, `LocaleChips` rendering the missing ones too, because "not translated yet" is
what an editor is scanning for. A single-locale site keeps the plain list and pays for no extra
query.

## Adding a field kind

Four touchpoints; TypeScript exhaustiveness will point at any you miss:

1. `FIELD_KINDS` and the discriminated union in `packages/core/src/fields.ts`
2. `buildEntryValidator` in the same file
3. `blankField` in `src/components/fields-editor.tsx` (plus a `…Config` block there if the kind
   carries options of its own)
4. `FieldInput` in `src/components/field-input.tsx`

A kind whose value the *CMS* assigns needs a fifth: the write path in `apps/api/src/lib/entries.ts`.
`code` is the one that does — `applyGeneratedCodes` fills it and discards whatever a client sent, on
create, update and revision restore alike, so the REST API, the MCP tools and the version routes all
get the same answer. Its control here is `disabled` for that reason and not as a styling choice:
there is no input to take, because there is no value a caller can set.
