import { z } from 'zod'

/**
 * The running version of Hedge, in one place. The API health route, the MCP server info and the
 * admin all import this — it replaces the copy that used to be hardcoded in each of them. Bump it
 * together with the workspace `package.json` versions and a git tag when cutting a release; the
 * checklist is in `.claude/rules/workers-config.md`.
 */
export const HEDGE_VERSION = '0.0.3'

/**
 * The canonical upstream the update check compares a deployment against — deliberately *not* a
 * fork. A deployment is someone's fork that Workers Builds redeploys on push, so "is there a newer
 * Hedge?" is a question about this repository's releases, not their own.
 */
export const HEDGE_REPO = 'bihaviour/hedge-cms'

export interface SemVer {
  major: number
  minor: number
  patch: number
}

/**
 * Parse a semantic version, tolerating a leading `v` (GitHub release tags carry it) and ignoring
 * any `-prerelease`/`+build` suffix. Returns `null` for anything that isn't `x.y.z`, so callers
 * can decide what an unrecognisable version means rather than throwing.
 */
export function parseVersion(input: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(input.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** `<0` if `a` is older than `b`, `0` if equal, `>0` if newer. An unparseable side sorts oldest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch
}

/** True only when `latest` is a strictly newer release than what is `current`ly running. */
export function isUpdateAvailable(current: string, latest: string | null): boolean {
  return latest != null && compareVersions(latest, current) > 0
}

/**
 * What `GET /api/v1/system/version` reports: the running version, the latest upstream release if
 * the check could reach GitHub (`null` if it couldn't — the admin treats that as "no update"
 * rather than an error), and enough to link the operator to the release notes and their own fork's
 * sync page.
 */
export const systemVersionSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** The GitHub release page for `latest`, or `null` when the check couldn't reach GitHub. */
  notesUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  checkedAt: z.string(),
  /** The deployment's own repo (`REPO_URL`) if set, so the admin can deep-link the fork sync. */
  repoUrl: z.string().nullable(),
})

export type SystemVersion = z.infer<typeof systemVersionSchema>
