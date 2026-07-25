import type { Role } from '@hedge/core'

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

export interface Actor {
  kind: 'user' | 'api_key'
  id: string
  role: Role
  scopes: string[]
}

export interface Variables {
  actor: Actor | null
  requestId: string
}

export interface AppEnv {
  Bindings: Bindings
  Variables: Variables
}
