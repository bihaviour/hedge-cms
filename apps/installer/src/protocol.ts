/**
 * The shapes the installer's page and its local runner exchange.
 *
 * Defined once and imported by both sides, the same reason `packages/core` exists for the Worker and
 * the admin — but kept here rather than in core, because this wire is entirely internal to the
 * installer and both ends of it ship in the same artifact. Nothing in the Worker or the admin has
 * any business knowing these shapes.
 */

/**
 * The Cloudflare resource names an install creates, all derived from the one name the operator
 * chooses. Lives here rather than in `install.ts` so the page can preview them without pulling the
 * install sequence — and its `@hedge/deploy` dependency tree — into a browser bundle. Deriving them
 * in one place is what stops the preview drifting from what actually gets created.
 */
export const derivedNames = (name: string) => ({
  script: name,
  database: `${name}-db`,
  bucket: `${name}-media`,
})

/** One of the resources an install creates, named so a failed run can be cleaned up or resumed. */
export interface CreatedResource {
  kind: 'd1' | 'r2' | 'worker'
  /** The name the operator will see in their Cloudflare dashboard. */
  name: string
  /** The account-specific id, where the resource has one (D1 does; R2 and Workers go by name). */
  id?: string
  /** False when the resource already existed and this run adopted it — a resumed install. */
  created: boolean
}

/** The steps, in the order they run. The UI renders one line per step. */
export const INSTALL_STEPS = [
  'database',
  'bucket',
  'migrations',
  'assets',
  'worker',
  'subdomain',
] as const

export type InstallStep = (typeof INSTALL_STEPS)[number]

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface StepState {
  step: InstallStep
  status: StepStatus
  /** What happened, in the operator's terms. Null while pending. */
  detail: string | null
}

/** An account the token can reach, for the picker. */
export interface CloudflareAccount {
  id: string
  name: string
}

/** `POST /api/accounts` — verify the token and list what it can reach. */
export interface AccountsRequest {
  token: string
}

export interface AccountsResponse {
  accounts: CloudflareAccount[]
  /** The release the installer will deploy, resolved from the upstream repo at the same time. */
  version: string
}

/** `POST /api/install` — everything the operator chose, plus the credential, once. */
export interface InstallRequest {
  token: string
  accountId: string
  /** The Worker's script name. The D1 and R2 names are derived from it. */
  name: string
  /** `APP_NAME` — what the deployment calls itself in the admin and in email. */
  appName: string
  /** `EMAIL_FROM` / `EMAIL_FROM_NAME`. Both optional: nothing sends until a domain is onboarded. */
  emailFrom: string
  emailFromName: string
}

/** Streamed to the page as the install runs, one JSON object per SSE event. */
export type InstallEvent =
  | { type: 'step'; state: StepState }
  | { type: 'resource'; resource: CreatedResource }
  | { type: 'done'; result: InstallResult }

export interface InstallResult {
  ok: boolean
  /** The URL the deployment answers on, once it is routable. Null if it never got that far. */
  url: string | null
  version: string
  steps: StepState[]
  /**
   * Everything this run created or adopted. Reported whether it succeeded or failed — a half-done
   * install that leaves a D1 database the operator cannot find is a bill they cannot explain.
   */
  created: CreatedResource[]
  /** A single summary, including what to do next when something went wrong. */
  message: string
}
