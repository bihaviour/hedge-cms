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
  /**
   * For a user, the *slug* of their instance role — built-in or custom. For an API key, the site
   * `Role` its scopes imply (a key never has instance authority). Instance authority for a user is
   * decided by `permissions`, not by this; site authority still reads it as a `Role`.
   */
  role: string
  /**
   * The instance permissions the user's role carries — the basis for every instance-level check
   * (`requirePermission`). Empty for an API key, which cannot reach the management API at all.
   */
  permissions: string[]
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
