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
| Step-up sign-in | `login_challenges`, `trusted_devices` |
| MCP OAuth | `oauth_applications`, `oauth_access_tokens`, `oauth_consents` |
| Members (Better Auth member instance) | `members`, `member_sites`, `member_sessions`, `member_accounts`, `member_verifications` |
| Content | `collections`, `entries`, `entry_revisions`, `entry_versions`, `entry_version_approvals`, `media`, `api_keys` |
| Newsletters | `newsletters`, `newsletter_templates`, `subscribers` |
| Email | `email_config` (the one global CMS sender), `email_senders` (a site's address book, #136), `email_templates`, `email_log` |
| Analytics | `analytics_daily` |

Row types are exported at the bottom of `schema.ts` (`SiteRow`, `EntryRow`, …) — use those rather
than re-deriving `$inferSelect` at the call site.

## Step-up sign-in tables

`login_challenges` is written from the sign-in path, which is unauthenticated — but it is bounded by
construction rather than by a retention job, and both halves of that matter:

- A row is only inserted **after the password has verified**, so an anonymous caller cannot write here
  at all.
- `startLoginChallenge` spends the user's existing challenges before inserting, so one user holds at
  most one row. Ceiling is the user count.

Lapsed rows are swept from the sign-in path (`pruneExpiredChallenges`) rather than the daily cron, so
the table stays tidy without depending on a job that a fresh deployment may not have run yet. A
challenge is always deleted together with the session its parked cookies address — see `auth.md`.

## Analytics rollups

`analytics_daily` is written by a **public** endpoint, so it is the one table whose growth is not
bounded by how many people have admin accounts. Two rules keep it honest, and both are load-bearing:

- **Aggregate on write, no raw event table.** The collector increments a bucket keyed by
  `(siteId, date, path, metric, key)`. A million hits on one article on one day is one row.
- **`entryId` is deliberately not in the unique index**, even though it describes the bucket.
  SQLite treats NULLs as *distinct* inside a unique index, so a nullable column there would mean
  every view of a non-entry page conflicted with nothing and inserted a fresh row — unbounded growth
  that looks fine until a site has a page without an entry. It costs nothing to leave out: `entryId`
  is resolved *from* the path, so two rows with the same path agree on it by construction.

The dimension caps in `@hedge/core`'s `analytics.ts` bound the last term; retention is a daily cron
(`.claude/rules/workers-config.md`). If a reporting query cannot use `(siteId, date)`, the index is
wrong — fix the index, don't write a query that works around it.

## Entries

Entries are keyed by (site, collection, slug, **locale**) — every read and write takes a locale,
defaulting to `en`. An update writes a revision snapshot into `entry_revisions` first. Status
transitions set `publishedAt`. Uniqueness collisions surface as `ApiError.conflict`.

A `code` field (`RB-0007`) is the CMS's own identifier for a piece and is **not** a column — it
lives in `data` like any other field, and `applyGeneratedCodes` assigns it. Two consequences worth
knowing before writing a query against one: the sequence is `max + 1` read back out of
`json_extract(data, '$.<field>')`, ordered by *length then value* so it stays correct once the count
outgrows the padding; and a translation carries its sibling's code rather than taking a new one —
the code names the piece, the row names one language of it. It is not unique in the database and
nothing downstream may assume it is.

## A post is a translation group, not a slug

**`entries.translationGroupId` is what makes several rows one piece.** One row per language, sharing
a group. It is a plain column and not a table: a group has no attributes of its own, so a table for
it would be a primary key and nothing else, and deleting the last variant retires the group by
leaving nothing that references it.

This replaced grouping-by-slug, and the reason is worth keeping. Translations used to be *defined*
as the same slug in another locale, which meant a piece could not have a URL in each language —
`/id/halo-dunia` was unreachable, so anyone who wanted one authored a genuinely separate post. The
group is what lets `hello-world` and `halo-dunia` be one piece. Three rules follow, all enforced in
`lib/entries.ts` rather than by the schema:

- **A slug names exactly one post, across the whole collection** (`assertSlugFree`). Not a database
  constraint, because within one post a slug may legally repeat across languages — every deployment
  that predates this column looks like that. But it has to hold, because the delivery API resolves a
  slug to a *post* and then picks a language: two posts sharing a slug would make that ambiguous.
- **A post holds one variant per language** (`assertLocaleFree`). The unique index on
  (collection, slug, locale) catches only the case where the slugs also match; two different slugs
  in one post both claiming Indonesian is the shape it cannot see.
- **Creating with a slug another language already uses still joins that post.** The back-compat
  path, and the one the admin's "no translation yet, saving creates one" flow relied on before
  `translationOf` existed. `translationOf` is the explicit form and the only one that works when the
  new variant is given its own slug.

`attachTranslation` / `detachTranslation` are the only things that move a row between groups. They
merge and split *whole posts*, never single rows — attaching a piece that is already a pair brings
the pair, or the variant left behind would be stranded in a post whose sibling had walked away. A
merge changes what rows belong to, never what they say: slugs, statuses, revisions and versions are
untouched, so nothing published changes and no URL moves. The joined rows do adopt the surviving
post's `code`, because the pieces are becoming one piece.

The `0014` backfill is that old rule written down: every locale of one (collection, slug) became one
group, derived from the lowest entry id in the set because SQL has no `newId()`.

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
