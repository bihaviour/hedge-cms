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
  EMAIL_FROM: string
  EMAIL_FROM_NAME: string

  /** HMAC key for session ids, invite tokens and API key hashing. */
  AUTH_SECRET: string
}

/** A caller allowed into the CMS: a signed-in user, or an API key acting on one site's behalf. */
export interface Actor {
  kind: 'user' | 'api_key'
  id: string
  role: Role
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
  requestId: string
}

export interface AppEnv {
  Bindings: Bindings
  Variables: Variables
}
