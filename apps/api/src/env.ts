import type { Role, SitePermission } from '@hedge/core'
import type { MemberRow, SiteRow } from './db/schema'
import type { PreviewClaims } from './lib/preview'

export interface Bindings {
  DB: D1Database
  MEDIA: R2Bucket
  EMAIL: SendEmail
  ASSETS: Fetcher

  ENVIRONMENT: 'development' | 'production'
  APP_NAME: string
  PUBLIC_URL: string
  /**
   * The deployment's own GitHub/GitLab repository — the repository the deploy button cloned. When
   * set, the admin's update notice can deep-link it. It changes nothing about how the Worker runs,
   * only where the "how do I update" link points.
   *
   * Optional because it is not declared in `wrangler.jsonc` — the setup page would demand a value
   * nobody can know before the clone exists. A Workers Builds deploy injects it from the
   * checkout's git origin (`scripts/deploy-worker.ts`); everywhere else it is simply absent.
   */
  REPO_URL?: string
  /**
   * How this deployment came to exist: `button`, `installer`, `cli`, or empty.
   *
   * A **display value only** — nothing about how the Worker runs reads it, and nothing trusts it. It
   * exists because the three install paths do not share an update path: an installer deployment has
   * no repository, so offering it the git fallback sends the operator somewhere that does not exist.
   * Each path labels itself — the committed config says `button`, a CLI deploy overrides that to
   * `cli` at deploy time (`scripts/deploy-worker.ts`), and the installer writes `installer` — so
   * the value is never asked of the operator.
   * Empty is the honest default for every deployment that predates this, and means "show the
   * dashboard update and the git fallback, claiming no relationship to a repository". A wrong value
   * costs an unhelpful instruction, never access. See issue #39.
   */
  INSTALLED_BY: string
  /**
   * The Cloudflare script name this Worker was uploaded under, when it isn't the `hedge-cms` in
   * `wrangler.jsonc`. Empty for a button or CLI deployment; set by the installer, which lets the
   * operator name the deployment.
   *
   * The runtime is not told its own script name, and the dashboard updater (#35) has to address the
   * script it is running as. Without this, a deployment installed under any other name could not
   * update itself.
   */
  WORKER_NAME: string
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
  /**
   * A valid preview token for this tenant, or null. Set on the delivery API only — see
   * `lib/preview.ts`. Being set says nothing about *which* entry it unlocks; `previewFor` decides.
   */
  preview: PreviewClaims | null
  /** The actor's role on `site`, memoised per request. `null` means no access; unset means
   * it has not been looked up yet. */
  siteRole?: Role | null
  /**
   * What the actor may do on `site`, memoised the same way (#151). `null` is no access at all —
   * distinct from an empty set, which is a role that reaches the site and may do nothing in it.
   */
  sitePermissions?: readonly SitePermission[] | null
  requestId: string
}

export interface AppEnv {
  Bindings: Bindings
  Variables: Variables
}
