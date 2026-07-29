/**
 * `@hedge/deploy` — everything needed to put a Hedge release onto a Cloudflare account.
 *
 * This started inside the Worker as the update path (#33, #34) and moved here when the installer
 * (#38) needed the same code to *create* a deployment rather than move one forward. Both do the same
 * work in the same order — read an artifact, provision, upload assets, upload the Worker, migrate —
 * so it is one implementation, not two that drift.
 *
 * Consumed as source, like `@hedge/core`: there is no build step, and nothing here is added to the
 * Worker bundle that wasn't in it before the move. The dependency runs one way — the Worker and the
 * installer both import this, and it imports neither. `apps/installer` is never a dependency of the
 * Worker that serves every request.
 *
 * It deliberately holds no `env`, no bindings and no Hono: every entry point takes a
 * `CloudflareClient` built from an account id and a token the caller supplies, so the token's
 * lifetime is the caller's call. In the Worker that is one request; in the installer it is one
 * process on the operator's own machine.
 */

export { type Artifact, fetchArtifact, readArtifact } from './artifact'
export { type CloudflareAccountSummary, listAccounts } from './cloudflare/accounts'
export {
  type AssetPayload,
  type AssetUploadSession,
  createAssetUploadSession,
  uploadAssets,
} from './cloudflare/assets'
export {
  type CloudflareApiError,
  type CloudflareClient,
  CloudflareError,
  cloudflareClient,
} from './cloudflare/client'
export { createDatabase, type D1QueryResult, d1Query, findDatabaseId } from './cloudflare/d1'
export { createBucket, findBucket } from './cloudflare/r2'
export {
  type CloudflareBinding,
  createDeployment,
  currentVersionId,
  type Deployment,
  enableWorkersDevSubdomain,
  findVersionByTag,
  inheritBindings,
  listDeployments,
  readScriptSettings,
  type ScriptSettings,
  scriptExists,
  type UploadVersionInput,
  uploadVersion,
  type WorkerVersion,
  workersDevSubdomain,
} from './cloudflare/scripts'
export { type TokenVerification, verifyToken } from './cloudflare/tokens'
export {
  appliedMigrations,
  type MigrationFile,
  type MigrationRunResult,
  runMigrations,
} from './migrate'
export {
  fetchReleaseArtifact,
  type GithubRelease,
  latestRelease,
  type ReleaseAsset,
  releaseByTag,
} from './release'
export { splitSqlStatements } from './sql-split'
