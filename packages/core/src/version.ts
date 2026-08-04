import { z } from 'zod'

/**
 * The running version of Hedge, in one place. The API health route, the MCP server info and the
 * admin all import this — it replaces the copy that used to be hardcoded in each of them. Bump it
 * together with the workspace `package.json` versions and a git tag when cutting a release; the
 * checklist is in `.claude/rules/workers-config.md`.
 */
export const HEDGE_VERSION = '0.0.13'

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
 * How a deployment came to exist. There are three ways after Stage 2 of issue #31, and they do not
 * share an update path — an installer deployment has no repository at all, so offering it the git
 * fallback sends the operator somewhere that does not exist.
 */
export const INSTALL_METHODS = ['button', 'installer', 'cli'] as const
export const installMethodSchema = z.enum(INSTALL_METHODS)
export type InstallMethod = z.infer<typeof installMethodSchema>

/**
 * Read the `INSTALLED_BY` var, tolerating anything.
 *
 * **Unknown has to degrade to something safe and true**, because every deployment that existed
 * before this var will never have it set, and they must keep seeing correct instructions. `null`
 * means "show the dashboard update *and* the git fallback, claiming no relationship to a
 * repository" — which is exactly what the admin did before this existed.
 */
export function parseInstallMethod(value: string | undefined | null): InstallMethod | null {
  const parsed = installMethodSchema.safeParse(value?.trim().toLowerCase())
  return parsed.success ? parsed.data : null
}

/**
 * One published upstream release, as the About page's changelog shows it.
 *
 * `notes` is the release body verbatim — GitHub-flavoured markdown, which the admin renders itself
 * (`lib/release-notes.ts`). It is deliberately carried as text rather than as HTML: the response is
 * built from a third-party API, and text that only ever becomes React elements cannot inject markup
 * however the upstream release was written.
 */
export const releaseNoteSchema = z.object({
  /** The release tag, `v`-prefixed as GitHub reports it. */
  version: z.string(),
  /** The release title, which is often just the tag again, or `null` when it was left empty. */
  name: z.string().nullable(),
  url: z.string(),
  publishedAt: z.string().nullable(),
  notes: z.string(),
  /** True when the body was longer than the server's cap and was cut — the admin says so. */
  truncated: z.boolean(),
})

export type ReleaseNote = z.infer<typeof releaseNoteSchema>

/**
 * The releases a deployment running `current` has not yet moved to, newest first — what "what
 * changed?" actually means to an operator who is several releases behind. Same ordering the list
 * arrives in, so it is a filter and nothing more.
 */
export function releasesSince(current: string, releases: ReleaseNote[]): ReleaseNote[] {
  return releases.filter((release) => compareVersions(release.version, current) > 0)
}

/**
 * What `GET /api/v1/system/version` reports: the running version, the latest upstream release if
 * the check could reach GitHub (`null` if it couldn't — the admin treats that as "no update"
 * rather than an error), and enough to show the operator an update path that exists for them.
 */
export const systemVersionSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** The GitHub release page for `latest`, or `null` when the check couldn't reach GitHub. */
  notesUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  checkedAt: z.string(),
  /** The deployment's own repo (`REPO_URL`) if set, so the admin can deep-link it. */
  repoUrl: z.string().nullable(),
  /**
   * How this deployment was installed, or `null` when it never said. A **display value only** —
   * it decides which instructions the About page renders and nothing else, and nothing trusts it.
   * A wrong value costs an unhelpful instruction, never access.
   */
  installedBy: installMethodSchema.nullable(),
  /**
   * Recent upstream releases, newest first — the changelog the About page renders, so "an update is
   * available" can be read as *what* the update changes. Empty when the check couldn't reach GitHub,
   * which is the same degradation `latest: null` already is.
   */
  releases: z.array(releaseNoteSchema),
})

export type SystemVersion = z.infer<typeof systemVersionSchema>
