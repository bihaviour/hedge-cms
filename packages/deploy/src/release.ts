import { HEDGE_VERSION } from '@hedge/core'
import { type Artifact, fetchArtifact } from './artifact'

/**
 * Finding a Hedge release on GitHub and turning it into an `Artifact`.
 *
 * Both callers need exactly this and nothing more: the updater resolves a specific tag it was asked
 * to move to, the installer resolves whatever is newest. Neither authenticates — these are public
 * releases, and a token here would be a credential with no reason to exist.
 */

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface GithubRelease {
  tag_name: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets: ReleaseAsset[]
}

const headers = {
  accept: 'application/vnd.github+json',
  // GitHub rejects API requests that arrive without a User-Agent.
  'user-agent': `hedge-cms/${HEDGE_VERSION}`,
}

/** A release by its exact tag. Throws when the tag has no release. */
export async function releaseByTag(repo: string, tag: string): Promise<GithubRelease> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers,
  })
  if (!response.ok) {
    throw new Error(`could not find release ${tag} upstream (HTTP ${response.status})`)
  }
  return (await response.json()) as GithubRelease
}

/**
 * The newest published release, or `null` when the repository has none. Drafts and prereleases are
 * excluded by the endpoint itself — `/releases/latest` never returns one — which is the behaviour
 * the update check relies on too, so work-in-progress tags never reach a self-hoster.
 */
export async function latestRelease(repo: string): Promise<GithubRelease | null> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers })
  if (!response.ok) return null
  return (await response.json()) as GithubRelease
}

/**
 * Download a release's update artifact and verify it against the `.sha256` published beside it.
 *
 * A release can exist and be *visible* to the update check while carrying no artifact — the tarball
 * is attached by a separate CI job (`.github/workflows/release.yml`) — so the absence of either asset
 * is a first-class outcome, not a surprise. `fetchArtifact` refuses a checksum mismatch, which is
 * what makes it safe for either caller to run the resulting bytes as code.
 */
export async function fetchReleaseArtifact(release: GithubRelease): Promise<Artifact> {
  const tarball = release.assets.find((asset) => asset.name.endsWith('.tar.gz'))
  const checksum = release.assets.find((asset) => asset.name.endsWith('.tar.gz.sha256'))
  if (!tarball || !checksum) {
    throw new Error(`release ${release.tag_name} has no Hedge update artifact attached`)
  }

  const checksumBody = await (await fetch(checksum.browser_download_url)).text()
  // sha256sum format: the hex digest, then the filename.
  const expected = checksumBody.trim().split(/\s+/)[0] ?? ''
  return fetchArtifact(tarball.browser_download_url, expected)
}
