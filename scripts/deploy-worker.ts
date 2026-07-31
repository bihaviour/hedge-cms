/**
 * The `wrangler deploy` step of `bun run deploy`, plus the two vars whose correct value depends on
 * *which install path* is deploying — decided here, at deploy time, instead of being typed into the
 * deploy button's setup page (which renders every declared var as a required field):
 *
 * - `INSTALLED_BY` is committed as `button` in `wrangler.jsonc`, because Workers Builds — the thing
 *   that deploys for a button installation — deploys the committed config verbatim. A deploy from a
 *   terminal is a CLI installation, so it overrides the value to `cli`.
 * - `REPO_URL` is not in `wrangler.jsonc` at all: its value cannot be known before the button has
 *   created the clone. Under Workers Builds the checkout's `origin` *is* that clone, so it is
 *   derived from git here — always current, never typed.
 *
 * Failing to derive the URL skips the flag rather than failing the deploy: `REPO_URL` is display
 * only, and the About page falls back to the upstream release notes without it.
 *
 * Runs with `apps/api` as the working directory (wrangler is installed there, not at the root) —
 * `bun run --cwd apps/api deploy` is the entry point, from the root `deploy` script.
 */

/**
 * A git remote as a plain https URL, or `null` for anything that cannot be turned into one.
 *
 * Stripping is not cosmetic: a CI checkout's remote may embed an access token
 * (`https://x-access-token:…@github.com/…`), and `REPO_URL` becomes a runtime var readable in the
 * dashboard and linked from the admin. Only the hostname and path survive — no credentials, no
 * port, no `.git` suffix.
 */
export function repoUrlFromRemote(remote: string): string | null {
  // The scp-like form (`git@github.com:user/repo.git`) is not a URL; rewrite it into one first.
  const scp = remote.trim().match(/^git@([^:/]+):(.+)$/)
  let url: URL
  try {
    url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote.trim())
  } catch {
    return null
  }
  if (!url.hostname || !url.pathname || url.pathname === '/') return null
  return `https://${url.hostname}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`
}

function originRepoUrl(): string | null {
  const git = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'])
  if (git.exitCode !== 0) return null
  return repoUrlFromRemote(git.stdout.toString())
}

if (import.meta.main) {
  const args = ['wrangler', 'deploy', '--config', '../../wrangler.jsonc']

  if (process.env.WORKERS_CI) {
    // Workers Builds: a button installation (or a hand-connected repository, which has the same
    // update paths). `INSTALLED_BY` stays the committed `button`; the repo is the checkout's own.
    const repoUrl = originRepoUrl()
    if (repoUrl) args.push('--var', `REPO_URL:${repoUrl}`)
  } else {
    args.push('--var', 'INSTALLED_BY:cli')
  }

  const wrangler = Bun.spawnSync(['bunx', ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(wrangler.exitCode ?? 1)
}
