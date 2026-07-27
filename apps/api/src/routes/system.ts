import { HEDGE_REPO, HEDGE_VERSION, isUpdateAvailable, type SystemVersion } from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requirePermission } from '../lib/auth'

const app = new Hono<AppEnv>()

/** How long a fetched "latest release" is trusted before GitHub is asked again. */
const CHECK_TTL_SECONDS = 60 * 60 * 6

interface GithubRelease {
  tag_name: string
  html_url: string
  published_at: string
  draft: boolean
  prerelease: boolean
}

/**
 * The latest upstream release, or `null` when GitHub can't be reached or the repo has none yet.
 *
 * The result is held in Cloudflare's edge cache: the unauthenticated GitHub API is rate-limited per
 * egress IP, and that IP is shared across every Worker on the colo, so an uncached check would burn
 * the budget in minutes. Even a `null` (a failed or rate-limited fetch) is cached, so one bad
 * moment doesn't turn every subsequent admin request into another doomed call to GitHub.
 */
async function latestRelease(): Promise<GithubRelease | null> {
  // Feature-detected: the Cache API only exists in the Workers runtime. Absent it (a test, say) the
  // check simply always hits the network, which is correct, just uncached.
  const cache = typeof caches !== 'undefined' ? caches.default : null
  const cacheKey = new Request(`https://hedge.internal/gh/${HEDGE_REPO}/latest-release`)

  const hit = await cache?.match(cacheKey)
  if (hit) return (await hit.json()) as GithubRelease | null

  let release: GithubRelease | null = null
  try {
    const response = await fetch(`https://api.github.com/repos/${HEDGE_REPO}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        // GitHub rejects API requests that arrive without a User-Agent.
        'user-agent': `hedge-cms/${HEDGE_VERSION}`,
      },
    })
    if (response.ok) {
      const body = (await response.json()) as GithubRelease
      // A draft or prerelease is not something to nudge a self-hoster toward.
      if (!body.draft && !body.prerelease) release = body
    }
  } catch {
    // Network failure, malformed JSON, GitHub down — degrade to "no update" rather than 500 the
    // admin over a version banner.
    release = null
  }

  await cache?.put(
    cacheKey,
    new Response(JSON.stringify(release), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${CHECK_TTL_SECONDS}`,
      },
    }),
  )
  return release
}

/**
 * Update awareness for a deployed instance. Admin-only, because it is a deployment-management
 * concern rather than a per-site one — the same reason it lives under `/api/v1/system`.
 */
app.get('/version', requirePermission('system:read'), async (c) => {
  const release = await latestRelease()
  const latest = release?.tag_name ?? null

  const payload: SystemVersion = {
    current: HEDGE_VERSION,
    latest,
    updateAvailable: isUpdateAvailable(HEDGE_VERSION, latest),
    notesUrl: release?.html_url ?? null,
    publishedAt: release?.published_at ?? null,
    checkedAt: new Date().toISOString(),
    // The deployment's own fork, if it told us — so the admin can deep-link its "Sync fork" page.
    repoUrl: c.env.REPO_URL?.trim() || null,
  }
  return c.json({ data: payload })
})

export default app
