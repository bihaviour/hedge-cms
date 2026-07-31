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
- **Both catalogs, always.** `catalog.test.ts` fails when an English key has no Indonesian
  translation, or when the two disagree on `{placeholders}`. A key present in one and missing from
  the other degrades silently to English and can sit unnoticed for a release, which is why it is a
  test rather than a habit.

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

## Adding a field kind

Four touchpoints; TypeScript exhaustiveness will point at any you miss:

1. `FIELD_KINDS` and the discriminated union in `packages/core/src/fields.ts`
2. `buildEntryValidator` in the same file
3. `blankField` in `src/pages/collection-settings.tsx`
4. `FieldInput` in `src/components/field-input.tsx`
