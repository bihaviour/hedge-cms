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

## Adding a field kind

Four touchpoints; TypeScript exhaustiveness will point at any you miss:

1. `FIELD_KINDS` and the discriminated union in `packages/core/src/fields.ts`
2. `buildEntryValidator` in the same file
3. `blankField` in `src/pages/collection-settings.tsx`
4. `FieldInput` in `src/components/field-input.tsx`
