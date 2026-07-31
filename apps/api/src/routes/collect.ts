import { ANALYTICS_COLLECT_PATH, collectEventSchema, SITE_HEADER } from '@hedge/core'
import { type Context, Hono } from 'hono'
import type { AppEnv } from '../env'
import { looksLikeBot, recordEvent, referrerHost, tracksRefused } from '../lib/analytics'
import { throttle } from '../lib/throttle'

/**
 * The analytics collector — mounted at `/api/v1/collect`, resolving no actor.
 *
 * It is on its own prefix rather than under `/api/v1/analytics` for the same reason
 * `/api/v1/newsletter` is not `/api/v1/newsletters`: the reporting API is a management surface in
 * `ADMIN_PREFIXES`, and putting a public writer under the same prefix would mean special-casing
 * inside the middleware whose entire value is that credential separation is decided once, by path.
 *
 * This is the only unauthenticated write path in the deployment besides newsletter signup, so it is
 * built for that: throttled per site and per IP, bounded in the rows any volume of traffic can
 * create (`lib/analytics.ts`), and silent. It answers `204` to everything — a valid beacon, a
 * malformed body, an unknown site, a throttled flood — because `navigator.sendBeacon` never reads a
 * response and a website must never break because analytics returned an error.
 */
const app = new Hono<AppEnv>()

/** Generous, because it is per IP and a reader legitimately loads many pages in an hour. */
const COLLECT_RULE = { window: 3600, max: 600 }

app.post('/', async (c) => {
  try {
    await collect(c)
  } catch (error) {
    // Includes the throttle's own rejection: a flood is dropped rather than told it was dropped.
    console.warn('[collect] dropped', error instanceof Error ? error.message : error)
  }
  return c.body(null, 204)
})

async function collect(c: Context<AppEnv>): Promise<void> {
  // Not tracking is the whole response to either signal. Checked before anything is parsed.
  if (tracksRefused(c.req.raw.headers)) return
  if (looksLikeBot(c.req.header('user-agent'))) return

  const site = c.get('site')
  if (!site) return

  const parsed = collectEventSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return

  await throttle(c, `collect:${site.id}`, COLLECT_RULE)

  // The deployment's own host counts as internal too: a preview opened from the admin, or a website
  // served from the same domain, is not a referral.
  const own = [site.domain, new URL(c.req.url).hostname]
  await recordEvent(c.env, site, parsed.data, referrerHost(parsed.data.referrer, own))
}

/**
 * The beacon script, served by the Worker so a website embeds one tag and nothing else.
 *
 * Deliberately tiny and dependency-free. It sets no cookie, reads no storage and sends no identity —
 * there is nothing here to put in a consent banner, which is the point. A site that runs its own
 * analytics simply never embeds it, and the CMS then shows content and newsletter metrics only.
 *
 * `hedge('share', target)` is exposed because **share intent is only observable in the website's own
 * click handler**: X removed its count endpoint, Facebook's needs an app token and LinkedIn withdrew
 * theirs, so no platform reports shares back. What a website can honestly measure is someone
 * clicking its own share or copy-link control, and that is what this records.
 */
app.get('/script.js', (c) => {
  c.header('content-type', 'application/javascript; charset=utf-8')
  // Long-lived: the script only changes when the deployment is updated, and a stale copy of a
  // beacon is harmless. `public` because it is identical for every reader.
  c.header('cache-control', 'public, max-age=3600, s-maxage=86400')
  return c.body(script(c.env.PUBLIC_URL))
})

function script(publicUrl: string): string {
  const endpoint = `${publicUrl}${ANALYTICS_COLLECT_PATH}`
  return `(function () {
  'use strict'
  // Do Not Track and Global Privacy Control are honoured by not sending. The endpoint checks the
  // headers too, so a patched script gains nothing.
  var n = navigator
  if (n.doNotTrack === '1' || n.globalPrivacyControl === true) return

  var el = document.currentScript
  var site = el && el.getAttribute('data-site')
  var url = ${JSON.stringify(endpoint)} + (site ? '?site=' + encodeURIComponent(site) : '')

  function send(body) {
    try {
      var payload = JSON.stringify(body)
      // sendBeacon survives the page being unloaded, which a fetch from a click handler may not.
      if (n.sendBeacon) {
        n.sendBeacon(url, new Blob([payload], { type: 'application/json' }))
      } else {
        fetch(url, { method: 'POST', body: payload, keepalive: true, mode: 'no-cors' })
      }
    } catch (e) {}
  }

  function view() {
    send({ path: location.pathname, event: 'view', referrer: document.referrer || undefined })
  }

  // The one hook a website calls from its own share and copy-link controls:
  //   hedge('share', 'x')   hedge('share', 'copy')
  window.hedge = function (event, target) {
    if (event === 'share' || event === 'share_intent') {
      send({ path: location.pathname, event: 'share_intent', target: String(target || 'unknown') })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', view, { once: true })
  } else {
    view()
  }
})()
`
}

/** Exported for the CORS registration in `index.ts`, which has to name the same header. */
export const COLLECT_ALLOWED_HEADERS = ['content-type', SITE_HEADER]

export default app
