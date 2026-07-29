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

## Comments in a migration are constrained — a local apply will not tell you

**`db:migrate` and `db:migrate:remote` do not parse the file the same way.** Locally, wrangler
splits it with its own comment-aware splitter and runs the statements. Remotely, it posts the file
to D1's HTTP API *verbatim* and that parser splits it — and it is stricter. Each of the following
applies cleanly to the local D1 and then fails a deploy with **"SQL code did not contain a
statement" [code: 7500]**:

| In a migration | Why it breaks remotely |
| --- | --- |
| A `;` inside any comment | The API splits on `;` before stripping comments, so the fragment ahead of it arrives as a statement that isn't one |
| A `--` inside a *block* comment — including a `/* ----- section ----- */` ruler | Read as starting a line comment, which swallows the closing `*/`, so the block never ends and eats the rest of the file |
| A comment after the final statement | The trailing chunk is a comment with no statement in it |

Use `===` for section rulers, keep comments free of semicolons, and end the file on a statement.

**Verify a migration remotely before shipping it**, because nothing local covers the above. Create a
throwaway D1, point a scratch config's `DB` binding at it, apply, then delete it:

```bash
bunx wrangler d1 create hedge-migration-probe      # note the database_id
bunx wrangler d1 migrations apply DB --config <scratch>.jsonc --remote
bunx wrangler d1 delete hedge-migration-probe -y
```

Also avoid `CASE … END` in migration SQL: wrangler's *local* splitter treats `CASE` (and `BEGIN`) as
opening a compound statement that closes only on `END` followed by whitespace or `;`, so `… ELSE 0
END,` swallows every later semicolon and the rest of the file becomes one statement. Prefer a bare
comparison (`x IS NOT NULL` is already 1/0) or `IIF()`.

**None of the above is relaxed by the in-Worker migration runner** (`lib/migrate.ts`, issue #34).
That runner owns a comment- and compound-aware splitter (`lib/sql-split.ts`) and submits one
statement at a time, so the dashboard update path is immune to all three failure modes — but
`db:migrate:remote` still exists and still posts the whole file to D1's parser verbatim, so a
migration must keep obeying the constraints above regardless. The runner is compatible with wrangler
by construction: same `d1_migrations` table, same names (the filename *with* `.sql`), same ordering,
so a deployment updated once from the dashboard and once with `db:migrate:remote` never re-runs or
skips a migration. Migrations are still not transactional across files on D1, so the runner reports a
partial application honestly (which migration failed) rather than pretending the file rolled back.

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
