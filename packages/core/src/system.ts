import { z } from 'zod'

/**
 * The self-update surface, shared between three places that must agree on it:
 *
 * - the CI job (`scripts/build-artifact.ts`) that writes `hedge.json` into a release tarball,
 * - the Worker's artifact reader (`apps/api/src/lib/artifact.ts`) that parses it back,
 * - the update route (`POST /api/v1/system/update`) and the admin dialog that drive an update.
 *
 * Keeping the shapes here means the artifact a release publishes and the code that unpacks it are
 * type-checked against one definition, the same reason every request/response shape lives in core.
 */

/**
 * A binding the artifact declares its Worker needs — **type and name only, never an id**. The
 * `wrangler.jsonc` invariant (`.claude/rules/workers-config.md`) holds here too: `DB` and `MEDIA`
 * carry account-specific ids that the manifest must not encode, so an artifact built from a tag is
 * reproducible on anyone's account. The updater merges these declarations over the ids and secret
 * values it reads from the running deployment.
 *
 * `text` is only ever set for a plain-text var (`ENVIRONMENT`, `APP_NAME`, …): a var is not
 * account-specific, so the artifact can carry its default and a new version can introduce one.
 */
export const hedgeBindingSchema = z.object({
  /** Cloudflare binding type: `d1`, `r2_bucket`, `assets`, `send_email`, `plain_text`, … */
  type: z.string(),
  /** The name the binding is reachable under in `env`. */
  name: z.string(),
  /** The value, for `plain_text` vars only. Absent for every account-specific binding. */
  text: z.string().optional(),
})

export type HedgeBinding = z.infer<typeof hedgeBindingSchema>

/** One static asset in the artifact, with the hash Cloudflare's upload session is keyed on. */
export const hedgeAssetSchema = z.object({
  /** The path Cloudflare serves it at, leading slash included — `/index.html`, `/assets/app.js`. */
  path: z.string(),
  size: z.number().int().nonnegative(),
  /**
   * The 32-character hex hash the assets-upload-session manifest is keyed on. This is wrangler's
   * algorithm — `sha256(base64(contents) + extension).slice(0, 32)` — not a plain content hash, so
   * an upload session compares like-for-like and re-uploads only what changed. Getting it wrong
   * re-uploads every asset on every update, silently. See `lib/cloudflare/assets.ts`.
   */
  hash: z.string().length(32),
  /** The `Content-Type` Cloudflare should serve the asset with — derived from the path in CI. */
  contentType: z.string(),
})

export type HedgeAsset = z.infer<typeof hedgeAssetSchema>

/**
 * `hedge.json` — everything the updater would otherwise have to infer from `wrangler.jsonc`, so the
 * Worker never has to hash the whole SPA inside a request budget or read a config it doesn't ship.
 */
export const hedgeManifestSchema = z.object({
  version: z.string(),
  /** The Worker's entry module inside the artifact, e.g. `index.js`. */
  mainModule: z.string(),
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()),
  bindings: z.array(hedgeBindingSchema),
  /** The `assets` config block from `wrangler.jsonc`, mirrored so a new version keeps its routing. */
  assets: z.object({
    htmlHandling: z.string().optional(),
    notFoundHandling: z.string(),
    runWorkerFirst: z.array(z.string()),
  }),
  files: z.array(hedgeAssetSchema),
})

export type HedgeManifest = z.infer<typeof hedgeManifestSchema>

/**
 * The Cloudflare API token permission groups an update needs, named for the preflight. When one is
 * missing the update stops before mutating anything, saying which — never half-way through.
 */
export const REQUIRED_TOKEN_PERMISSIONS = ['Workers Scripts:Edit', 'D1:Edit'] as const

/**
 * `POST /api/v1/system/update`. The token is the operator's Cloudflare API token, presented once and
 * **never** written to D1, logged, or returned — this schema is the only place it exists, and only
 * for the duration of the request.
 */
export const systemUpdateSchema = z.object({
  /** A Cloudflare API token carrying the permissions in `REQUIRED_TOKEN_PERMISSIONS`. */
  token: z.string().min(1),
  /** The Cloudflare account id the Worker is deployed under. */
  accountId: z.string().min(1),
  /** The release tag to move to, e.g. `v0.0.4` — validated against the upstream latest release. */
  targetVersion: z.string().min(1),
})

export type SystemUpdateInput = z.infer<typeof systemUpdateSchema>

/** How each of the three steps ended. `skipped` is a real success: nothing needed doing. */
export const updateStepStatusSchema = z.enum(['skipped', 'done', 'failed'])
export type UpdateStepStatus = z.infer<typeof updateStepStatusSchema>

/** One migration's outcome. `already` means it was in `d1_migrations` before this run touched it. */
export const migrationOutcomeSchema = z.object({
  name: z.string(),
  status: z.enum(['applied', 'already', 'failed']),
  /** The failure, when `status` is `failed`. Null otherwise. */
  error: z.string().nullable(),
})

export type MigrationOutcome = z.infer<typeof migrationOutcomeSchema>

/**
 * The result of an update attempt, with a status per step so a partial failure is a first-class
 * state rather than a generic error. The admin renders exactly this — "migrations applied, not yet
 * deployed" is a real place an operator can end up and it has to be told apart from a clean success.
 */
export const systemUpdateResultSchema = z.object({
  ok: z.boolean(),
  fromVersion: z.string(),
  toVersion: z.string(),
  /** The version id Cloudflare assigned the uploaded version, once step 1 succeeds. */
  versionId: z.string().nullable(),
  steps: z.object({
    /** Upload the new Worker version without deploying it. */
    version: z.object({
      status: updateStepStatusSchema,
      detail: z.string().nullable(),
    }),
    /** Apply pending D1 migrations, in filename order, before any request reaches new code. */
    migrations: z.object({
      status: updateStepStatusSchema,
      detail: z.string().nullable(),
      applied: z.array(migrationOutcomeSchema),
    }),
    /** Point a deployment at the new version — the step that actually serves it. */
    deployment: z.object({
      status: updateStepStatusSchema,
      detail: z.string().nullable(),
    }),
  }),
  /** A single human-readable summary, including what to do next after a partial failure. */
  message: z.string(),
})

export type SystemUpdateResult = z.infer<typeof systemUpdateResultSchema>
