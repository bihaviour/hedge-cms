import { ANALYTICS_SCRIPT_PATH } from '@hedge/core'
import type { MiddlewareHandler } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { AppEnv } from '../env'

/** The public media passthrough in `index.ts`. Not `/api/v1/media`, which is management. */
export const MEDIA_PREFIX = '/media'

/**
 * Hono's defaults, which include `Cross-Origin-Resource-Policy: same-origin`. Right for every
 * response this deployment produces for itself: the admin SPA, the management API, the delivery
 * API. All of them are read by this origin or by `fetch`, and a CORS fetch is not subject to CORP.
 */
const managedHeaders = secureHeaders()

/**
 * Media is *embedded* by other origins — an `<img>` on the website this CMS serves — and an
 * embed is a `no-cors` request, the one kind CORP is checked on. Under `same-origin` the browser
 * fetches the image, gets a 200 with the right content type, and then throws the bytes away
 * without a console error, a CSP violation or a failed request: the image is simply blank.
 *
 * `cross-origin` is what a public asset host says, and it is the whole meaning of the route —
 * objects there are already served to anyone who has the URL, with no credential and no cookie.
 * The CORS headers on the delivery API do not help here, because a `no-cors` embed never reads
 * them; CORP is a separate gate, applied to the response rather than to the request.
 */
const publicAssetHeaders = secureHeaders({ crossOriginResourcePolicy: 'cross-origin' })

/**
 * The two responses another origin fetches with `no-cors` *and reads*, which is the combination
 * CORP breaks:
 *
 * - the media passthrough, an `<img>` on the website this CMS serves;
 * - the analytics beacon script, a `<script src>` on the same website (#104).
 *
 * Both fail the same silent way under `same-origin`: the browser makes the request, gets a 200 of
 * the right content type, and throws the bytes away. No 404, no CSP violation, no console error, no
 * failed request in the network panel — a blank image, or a tracker that downloads and never runs.
 * `curl` ignores CORP and a CORS `fetch` is not subject to it, so every check short of a real
 * browser passes while the feature is dead. That is how #104 shipped.
 *
 * **`POST /api/v1/collect` is deliberately not here, though CORP does apply to it.** `sendBeacon`
 * posts in `no-cors` mode, so the browser refuses the *response* — but CORP is enforced after the
 * Worker has already recorded the event, and nothing reads a `204` the script never looks at. The
 * write lands. Widening it would loosen the deployment's only unauthenticated write endpoint to buy
 * nothing, so the known cost is accepted instead: an `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` line in
 * the reader's console on each beacon, which is noise rather than a symptom. `collect.test.ts` and
 * the troubleshooting section of `docs/website-analytics.md` both say so, so it is not re-diagnosed
 * as this bug a second time.
 *
 * The script is matched **exactly** rather than by prefix, so the carve-out cannot creep onto a
 * route added under `/api/v1/collect/` later — including the collector itself.
 *
 * Two things for whoever edits this next:
 *
 * - **A newsletter open-tracking pixel would belong here**, and would fail exactly as the script
 *   did: an `<img>` loaded cross-origin in webmail is a no-cors read. Nothing tracks opens today
 *   (`lib/newsletter-stats.ts`, and #74 decided against it), so there is nothing to carve out —
 *   but carve it out *when it is added*, not after a day spent wondering why open rates are zero.
 * - **CORP is not the only header that silently breaks an embed.** `publicAssetHeaders` overrides
 *   CORP and inherits the rest of Hono's defaults, including `X-Frame-Options: SAMEORIGIN` — so a
 *   cross-origin `<iframe src=".../media/whitepaper.pdf">` is blocked, and presents as another
 *   blank embed with no error. `SAMEORIGIN` is the right default and the website only *links* PDFs
 *   today, so this is correct as it stands; check XFO as well as CORP before concluding otherwise.
 */
const isPublicAsset = (path: string) =>
  path === MEDIA_PREFIX || path.startsWith(`${MEDIA_PREFIX}/`) || path === ANALYTICS_SCRIPT_PATH

/**
 * One middleware, dispatching by path — deliberately, and not two `app.use` registrations.
 *
 * `secureHeaders` writes its headers *after* `await next()`, on the way back out, so with two
 * instances mounted the outer one runs last and overwrites the inner one. A second, narrower
 * `app.use('/media/*', …)` would look correct and do nothing, and so would setting the header in
 * the route handler. Whatever policy a path gets, it has to be chosen before the request goes
 * down, by the single instance that will write on the way back up.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = (c, next) =>
  isPublicAsset(c.req.path) ? publicAssetHeaders(c, next) : managedHeaders(c, next)
