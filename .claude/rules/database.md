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

**None of the above is relaxed by the migration runner** (`packages/deploy/src/migrate.ts`, issue
#34). That runner owns a comment- and compound-aware splitter (`packages/deploy/src/sql-split.ts`)
and submits one statement at a time, so it is immune to all three failure modes above — and it is now
what runs migrations on **two** of the three install paths: the in-Worker dashboard update (#35) and
the installer (#38). But `db:migrate:remote` still exists and still posts the whole file to D1's
parser verbatim, so **a migration must keep obeying the constraints above regardless**. Do not read
"the runner handles it" as permission to write a migration the third path chokes on.

The runner is compatible with wrangler by construction: same `d1_migrations` table, same names (the
filename *with* `.sql`), same ordering. So a deployment migrated once from the dashboard, once by the
installer and once with `db:migrate:remote` never re-runs or skips a migration. Migrations are still
not transactional across files on D1, so the runner reports a partial application honestly (which
migration failed) rather than pretending the file rolled back.

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
| Content | `collections`, `entries`, `entry_revisions`, `entry_versions`, `entry_version_approvals`, `media`, `api_keys` |

Row types are exported at the bottom of `schema.ts` (`SiteRow`, `EntryRow`, …) — use those rather
than re-deriving `$inferSelect` at the call site.

## Entries

Entries are keyed by (site, collection, slug, **locale**) — every read and write takes a locale,
defaulting to `en`. An update writes a revision snapshot into `entry_revisions` first. Status
transitions set `publishedAt`. Uniqueness collisions surface as `ApiError.conflict`.

## Revisions and versions are two sets, not one

`entry_revisions` is **backward-looking**: what an entry *was*, written automatically before every
update. `entry_versions` is **forward-looking** (#59): what it *may become*, written deliberately,
several open at once. Conflating them would make "restore" ambiguous, so they stay separate tables
with separate meanings — don't merge them or reuse one for the other.

Two things about `entry_versions` are load-bearing:

- **`siteId` is on the row**, not reached through `entries → collections`. The review queue is a
  per-site query and `siteId` is the boundary every content query filters on; two joins away is the
  wrong place for it. `(siteId, status)` is indexed for exactly that query.
- **A version's progress is derived, never stored.** `entry_version_approvals` holds one row per
  decision and is never updated in place; `clearedLevels` in `@hedge/core` counts them, and a
  rejection resets the count. There is deliberately no counter column for the two to disagree with.

`collections.approvalLevels` (0/1/2) is what switches the workflow on, and `0` is the default every
pre-existing collection carries — the feature ships inert. When it is non-zero, `updateEntry`,
`createEntry` and `restoreEntryRevision` all refuse a transition to `published`
(`assertPublishAllowed`), so the gate holds for the MCP tools as well as the REST routes. The one way
through is `publishEntryVersion`, which passes `viaApprovedVersion` and still goes out via
`updateEntry` so a revision is snapshotted like any other edit.
