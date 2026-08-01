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
 * One middleware, dispatching by path — deliberately, and not two `app.use` registrations.
 *
 * `secureHeaders` writes its headers *after* `await next()`, on the way back out, so with two
 * instances mounted the outer one runs last and overwrites the inner one. A second, narrower
 * `app.use('/media/*', …)` would look correct and do nothing, and so would setting the header in
 * the route handler. Whatever policy a path gets, it has to be chosen before the request goes
 * down, by the single instance that will write on the way back up.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = (c, next) => {
  const path = c.req.path
  const isMedia = path === MEDIA_PREFIX || path.startsWith(`${MEDIA_PREFIX}/`)
  return isMedia ? publicAssetHeaders(c, next) : managedHeaders(c, next)
}
