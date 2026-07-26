---
name: gh
description: Open and merge pull requests for hedge-cms with the gh CLI, including the repo's codegen and check gates. Use when the user wants to open a PR from the current branch, merge a PR, or check PR status. Triggers: /gh, "open a PR", "create a pull request", "merge this PR", "merge PR #N".
---

# /gh

PR flow for this repo. The generic version of this is easy; what is repo-specific is the set of
gates below, each of which turns into a red CI run if it is skipped.

## Usage

```
/gh                 # open a PR from the current branch to main
/gh open            # same, explicit
/gh open --draft    # open as a draft
/gh merge           # merge the PR for the current branch (squash)
/gh merge <N>       # merge PR number N
/gh <N>             # show PR N's status, then ask whether to merge
```

## Gates before opening

Run these in one batch and fix anything that fails — CI (`.github/workflows/ci.yml`) runs exactly
the same four, so a failure here is a failure there:

```bash
bun run lint && bun run typecheck && bun run test && bun run build
```

Then check what the branch touched, because two paths in this repo carry generated files:

| Changed | Must also be committed |
| --- | --- |
| `apps/api/src/db/schema.ts` | A migration in `apps/api/migrations/` **and** its `meta/` snapshot, from `bun run db:generate` |
| `wrangler.jsonc` (repository root) | `apps/api/worker-configuration.d.ts`, from `bun run cf-typegen` — generated, never hand-edited |

Verify a schema change applies rather than assuming: `bun run db:migrate` against the local D1.
Drizzle-kit's generated SQL is a starting point, not gospel — SQLite refuses `ADD COLUMN` for a
`NOT NULL` column with a foreign key, so any such column needs a hand-written
create/copy/drop/rename with a backfill. A migration that has never been run is not a migration.

Never open a PR from `main`. If `git branch --show-current` is `main`, stop and ask.

## Opening

1. `git push -u origin HEAD`
2. Draft the title and body from the commits on the branch — a short summary of what changed and
   why, and what was actually verified (commands run, behaviour exercised). Claims like "tested"
   with nothing behind them are worse than silence.
3. `gh pr create --base main --title "…" --body-file <tmp>` (add `--draft` when asked)
4. Print the URL that comes back.

## Merging

1. Resolve the PR: an explicit number, else `gh pr view --json number,title,state,mergeStateStatus`.
2. Check it before touching it:
   - `state` must be `OPEN` and `isDraft` false
   - `mergeStateStatus`: `CLEAN` and `UNSTABLE` are fine; `BLOCKED`, `BEHIND`, `DIRTY`, `DRAFT` are not
   - `gh pr checks <N>` — report a failing check, do not race it
3. Squash by default, and clean up the branch:

   ```bash
   gh pr merge <N> --squash --delete-branch
   ```

   `--rebase` when the commits are individually meaningful and the user wants them kept.

**Do not pass `--admin`.** It bypasses branch protection — required reviews and required checks —
and there is no situation in this repo where that is the right call without the user asking for it
in those words. Same for `--auto` unless they want it to land unattended.

Report a blocker instead of working around it. Never force-push or rewrite history to make a PR
mergeable without asking first.
