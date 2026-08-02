import {
  HEDGE_REPO,
  HEDGE_VERSION,
  isUpdateAvailable,
  parseInstallMethod,
  type ReleaseNote,
  type SystemVersion,
  systemUpdateSchema,
} from '@hedge/core'
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requirePermission } from '../lib/auth'
import { throttle } from '../lib/throttle'
import { runUpdate } from '../lib/update'
import { validate } from '../lib/validate'

const app = new Hono<AppEnv>()

/** How long a fetched release list is trusted before GitHub is asked again. */
const CHECK_TTL_SECONDS = 60 * 60 * 6

/**
 * How much of the changelog is carried, and it is a *response size* budget rather than a display
 * one. The admin's update banner shares this query with the About page, so this payload rides along
 * on every admin page load — and the bodies come from an upstream nobody here controls, which could
 * one day paste a migration guide into one. Ten releases at four kilobytes each is the ceiling; a
 * deployment further behind than that is told to read the rest on GitHub.
 */
const RELEASE_COUNT = 10
const NOTES_MAX_CHARS = 4000

interface GithubRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string
  draft: boolean
  prerelease: boolean
}

/** Trim a release body to the cap, cutting at a line break so the last line isn't half-rendered. */
function trimNotes(body: string): { notes: string; truncated: boolean } {
  const notes = body.replace(/\r\n/g, '\n').trim()
  if (notes.length <= NOTES_MAX_CHARS) return { notes, truncated: false }

  const cut = notes.slice(0, NOTES_MAX_CHARS)
  const lastBreak = cut.lastIndexOf('\n')
  return { notes: (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd(), truncated: true }
}

/**
 * Recent upstream releases, newest first — `[]` when GitHub can't be reached or the repo has none.
 *
 * This is one call for two questions: "is there a newer version?" is the first entry, and "what
 * changed?" is the rest. Asking `/releases/latest` for the former and the list for the latter would
 * double the spend on the budget the cache below exists to protect.
 *
 * The result is held in Cloudflare's edge cache: the unauthenticated GitHub API is rate-limited per
 * egress IP, and that IP is shared across every Worker on the colo, so an uncached check would burn
 * the budget in minutes. Even an empty answer (a failed or rate-limited fetch) is cached, so one bad
 * moment doesn't turn every subsequent admin request into another doomed call to GitHub.
 */
async function recentReleases(force = false): Promise<ReleaseNote[]> {
  // Feature-detected: the Cache API only exists in the Workers runtime. Absent it (a test, say) the
  // check simply always hits the network, which is correct, just uncached.
  const cache = typeof caches !== 'undefined' ? caches.default : null
  // Versioned key: what is stored here changed shape when the changelog was added, and a cached
  // answer from before that outlives the deploy that changed it.
  const cacheKey = new Request(`https://hedge.internal/gh/${HEDGE_REPO}/releases-v2`)

  // `force` skips reading the cache but still writes to it, so an operator who has just published a
  // release does not have to wait out `CHECK_TTL_SECONDS` to see it — and everyone after them gets
  // the fresh answer. It is rate limited at the route: the cache exists because GitHub's limit is
  // per egress IP and shared across the colo, so a refresh anyone could hold down would spend a
  // budget that is not this deployment's alone.
  const hit = force ? undefined : await cache?.match(cacheKey)
  if (hit) return (await hit.json()) as ReleaseNote[]

  let releases: ReleaseNote[] = []
  try {
    // A page of releases rather than `/releases/latest`: the newest is the update check, and the
    // ones behind it are what an operator several versions back needs to read. GitHub returns them
    // newest first, which is the order the changelog is shown in.
    const response = await fetch(
      `https://api.github.com/repos/${HEDGE_REPO}/releases?per_page=${RELEASE_COUNT}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          // GitHub rejects API requests that arrive without a User-Agent.
          'user-agent': `hedge-cms/${HEDGE_VERSION}`,
        },
      },
    )
    if (response.ok) {
      const body = await response.json()
      const rows: GithubRelease[] = Array.isArray(body) ? body : []
      releases = rows
        // A draft or prerelease is not something to nudge a self-hoster toward, and it has no place
        // in the changelog either — a note about work in progress reads as a note about a release.
        .filter((row) => !row.draft && !row.prerelease)
        .map((row) => ({
          version: row.tag_name,
          name: row.name?.trim() || null,
          url: row.html_url,
          publishedAt: row.published_at ?? null,
          ...trimNotes(row.body ?? ''),
        }))
    }
  } catch {
    // Network failure, malformed JSON, GitHub down — degrade to "no update" rather than 500 the
    // admin over a version banner.
    releases = []
  }

  await cache?.put(
    cacheKey,
    new Response(JSON.stringify(releases), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${CHECK_TTL_SECONDS}`,
      },
    }),
  )
  return releases
}

/**
 * Update awareness for a deployed instance. Admin-only, because it is a deployment-management
 * concern rather than a per-site one — the same reason it lives under `/api/v1/system`.
 */
app.get('/version', requirePermission('system:read'), async (c) => {
  // `?refresh=1` is the "check again" button on the About page. Without it there is no way to learn
  // about a release published inside the TTL except to wait it out, which is exactly the moment an
  // operator most wants an answer — they have usually just cut the release themselves.
  const force = c.req.query('refresh') === '1'
  // Tighter than most limits here, and deliberately so: this is the one path that can reach GitHub
  // on demand, and the budget it spends is shared with every other Worker on the colo.
  if (force) await throttle(c, 'system-version-refresh', { window: 15 * 60, max: 5 })

  const releases = await recentReleases(force)
  // Newest first, so the first row is both "the latest release" and the top of the changelog.
  const release = releases[0] ?? null
  const latest = release?.version ?? null

  const payload: SystemVersion = {
    current: HEDGE_VERSION,
    latest,
    updateAvailable: isUpdateAvailable(HEDGE_VERSION, latest),
    notesUrl: release?.url ?? null,
    publishedAt: release?.publishedAt ?? null,
    checkedAt: new Date().toISOString(),
    // The deployment's own repository, if it told us — so the admin can deep-link it.
    repoUrl: c.env.REPO_URL?.trim() || null,
    // How it was installed, so the About page offers the update path that exists for it (#39).
    // Anything unrecognised — including the empty default every older deployment has — resolves to
    // null, which the admin reads as "show both paths, claim no repository".
    installedBy: parseInstallMethod(c.env.INSTALLED_BY),
    // The changelog: what the update actually changes, rather than only that it exists.
    releases,
  }
  return c.json({ data: payload })
})

/**
 * Update the deployment to a newer release. `system:update` is owner-only (the built-in `admin` role
 * doesn't carry it) — one step above the `system:read` gate on `/version`, because this rewrites the
 * deployment rather than reporting on it.
 *
 * The token in the body is the operator's Cloudflare API token, presented once and never persisted:
 * it lives only for this request, inside the deploy client. `/api/v1/system` is in `ADMIN_PREFIXES`,
 * so only an admin session reaches here at all; the `system:update` permission narrows that to owner.
 */
app.post('/update', requirePermission('system:update'), async (c) => {
  // A retried update is expensive for the Cloudflare API and for the deployment. Rate-limit it.
  await throttle(c, 'system-update', { window: 300, max: 5 })

  const input = await validate(c, systemUpdateSchema)
  // A Worker is not told its own script name, so an installer deployment records the one it was
  // uploaded under (#38). Empty for a button or CLI deploy, which is always `hedge-cms`.
  const result = await runUpdate(input, { scriptName: c.env.WORKER_NAME })
  return c.json({ data: result })
})

export default app
