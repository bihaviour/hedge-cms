# Rule: Database and migrations (`apps/api/src/db/`, `apps/api/migrations/`)

Read before changing `schema.ts` or writing a query.

## Workflow — the migration is not optional

1. Edit `apps/api/src/db/schema.ts`.
2. `bun run db:generate` — drizzle-kit writes the SQL **and** a `migrations/meta/` snapshot.
3. `bun run db:migrate` — apply it to the local D1. **Verify it applies; do not assume.**
4. Commit the schema, the SQL, and the snapshot together. A migration that has never been run is
   not a migration.

Drizzle-kit's SQL is a starting point, not gospel. SQLite refuses `ADD COLUMN` for a `NOT NULL`
column with a foreign key, so such a column needs a hand-written create/copy/drop/rename with a
backfill. Never edit an already-applied migration — add a new one.

## Conventions

- `getDb(env)` from `db/client.ts` is the only way in. D1 connections are per-request and cheap;
  there is nothing to pool. `casing: 'snake_case'` maps camelCase columns automatically.
- Ids come from `newId('prefix')` (`lib/id.ts`): Crockford base32, timestamp-prefixed, so sorting by
  id sorts by creation time and keyset pagination stays cheap on D1. Better Auth is configured to
  generate ids the same way, so its rows read like ours.
- **Timestamps differ by table family.** Content tables store ISO strings (`timestamps` helper);
  the tables Better Auth owns store epoch integers (`authTimestamps`), because its adapter hands the
  adapter `Date` objects. Convert to ISO at the route boundary.
- `siteId` is the tenant boundary — everything content-shaped hangs off one. A query that touches
  collections, entries, media, API keys or members and does not filter on `siteId` is a bug.
- No cross-table `JOIN` habits from a bigger database: D1 is SQLite at the edge, so prefer indexed
  lookups and the explicit indexes already declared in `schema.ts`.

## Table families

| Family | Tables |
| --- | --- |
| Tenancy | `sites`, `site_users` |
| Operators (Better Auth CMS instance) | `users`, `sessions`, `accounts`, `verifications`, `rate_limits`, `auth_tokens` |
| MCP OAuth | `oauth_applications`, `oauth_access_tokens`, `oauth_consents` |
| Members (Better Auth member instance) | `members`, `member_sites`, `member_sessions`, `member_accounts`, `member_verifications` |
| Content | `collections`, `entries`, `entry_revisions`, `media`, `api_keys` |

Row types are exported at the bottom of `schema.ts` (`SiteRow`, `EntryRow`, …) — use those rather
than re-deriving `$inferSelect` at the call site.

## Entries

Entries are keyed by (site, collection, slug, **locale**) — every read and write takes a locale,
defaulting to `en`. An update writes a revision snapshot into `entry_revisions` first. Status
transitions set `publishedAt`. Uniqueness collisions surface as `ApiError.conflict`.
