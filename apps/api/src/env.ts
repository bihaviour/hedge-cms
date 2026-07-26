import type { Role } from '@hedge/core'
import type { MemberRow, SiteRow } from './db/schema'

export interface Bindings {
  DB: D1Database
  MEDIA: R2Bucket
  EMAIL: SendEmail
  ASSETS: Fetcher

  ENVIRONMENT: 'development' | 'production'
  APP_NAME: string
  PUBLIC_URL: string
  /**
   * The deployment's own GitHub/GitLab repository — the fork the deploy button created. Empty by
   * default; when set, the admin's update notice can deep-link its "Sync fork" page. It changes
   * nothing about how the Worker runs, only where the "how do I update" link points.
   */
  REPO_URL: string
  EMAIL_FROM: string
  EMAIL_FROM_NAME: string

  /**
   * Better Auth's signing secret, and the HMAC key for delivery API keys and invite tokens.
   * Rotating it invalidates every session, every invite link and every API key.
   */
  AUTH_SECRET: string
}

/**
 * A caller allowed into the CMS.
 *
 * `kind` is *who* is acting: a person, or a key acting for one site. `via` is what they presented,
 * which matters because the three credentials do not reach the same routes — a delivery key is
 * only resolved on the delivery API, and an OAuth token only on the MCP endpoint.
 */
export interface Actor {
  kind: 'user' | 'api_key'
  via: 'session' | 'oauth' | 'api_key'
  id: string
  role: Role
  /** Scopes carried by a key or a delegated OAuth client. Empty for a signed-in user. */
  scopes: string[]
  /** Set for API keys, which are issued per site. Users are global to the deployment. */
  siteId: string | null
}

export interface Variables {
  actor: Actor | null
  /** The tenant this request is operating on — see `lib/site.ts`. */
  site: SiteRow | null
  /** A signed-in website member. Never grants access to anything under the admin API. */
  member: MemberRow | null
  /** The actor's role on `site`, memoised per request. `null` means no access; unset means
   * it has not been looked up yet. */
  siteRole?: Role | null
  requestId: string
}

export interface AppEnv {
  Bindings: Bindings
  Variables: Variables
}
