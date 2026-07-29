import {
  HEDGE_REPO,
  HEDGE_VERSION,
  type HedgeManifest,
  parseVersion,
  type SystemUpdateInput,
  type SystemUpdateResult,
} from '@hedge/core'
import type { Artifact } from './artifact'
import { fetchArtifact } from './artifact'
import { createAssetUploadSession, uploadAssets } from './cloudflare/assets'
import { type CloudflareClient, CloudflareError, cloudflareClient } from './cloudflare/client'
import { d1Query, findDatabaseId } from './cloudflare/d1'
import {
  type CloudflareBinding,
  createDeployment,
  currentVersionId,
  findVersionByTag,
  inheritBindings,
  readScriptSettings,
  uploadVersion,
} from './cloudflare/scripts'
import { verifyToken } from './cloudflare/tokens'
import { ApiError } from './errors'
import { runMigrations } from './migrate'

/**
 * Moves a deployment from the running version to a newer release (#35).
 *
 * The order is the whole point: upload the new Worker version *without* deploying it, apply pending
 * migrations, and only then create a deployment. So new code never reaches a request against a
 * schema it hasn't migrated — the failure mode a naive "upload and go" has. Each step reports its
 * own outcome, and a failure stops the sequence exactly where it is rather than pressing on.
 *
 * The Cloudflare token lives only in the `CloudflareClient` closure for the life of the call. It is
 * never written to D1, never logged, and never part of the result — `mcp`/route tests pin that.
 */

/**
 * The Worker's script name on Cloudflare — the `name` in `wrangler.jsonc`. The runtime is not told
 * its own script name, so this is the one assumption the updater makes about the deployment; a
 * renamed script is reported as "not found" rather than mutating the wrong Worker.
 */
const WORKER_NAME = 'hedge-cms'
const D1_DATABASE_NAME = 'hedge-db'

interface Preflight {
  client: CloudflareClient
  scriptName: string
  databaseId: string
  currentBindings: CloudflareBinding[]
  artifact: Artifact
  tag: string
}

export async function runUpdate(input: SystemUpdateInput): Promise<SystemUpdateResult> {
  const pre = await preflight(input)
  const { client, scriptName, databaseId, artifact, tag } = pre
  const manifest = artifact.manifest

  const result: SystemUpdateResult = {
    ok: false,
    fromVersion: HEDGE_VERSION,
    toVersion: manifest.version,
    versionId: null,
    steps: {
      version: { status: 'skipped', detail: null },
      migrations: { status: 'skipped', detail: null, applied: [] },
      deployment: { status: 'skipped', detail: null },
    },
    message: '',
  }

  // Step 1 — upload the new version, without deploying it. Idempotent: a resumed update finds the
  // version it already uploaded (tagged with the target) instead of stacking a duplicate.
  let versionId: string
  try {
    const existing = await findVersionByTag(client, scriptName, tag)
    if (existing) {
      versionId = existing
      result.steps.version = { status: 'skipped', detail: 'version already uploaded' }
    } else {
      versionId = await uploadNewVersion(pre, manifest)
      result.steps.version = { status: 'done', detail: null }
    }
    result.versionId = versionId
  } catch (error) {
    result.steps.version = { status: 'failed', detail: describe(error) }
    result.message = `Update failed while uploading the new version. Nothing changed — ${describe(error)}`
    return result
  }

  // Step 2 — migrations, before any request reaches the new code.
  const migration = await runMigrations(client, databaseId, artifact.migrations())
  result.steps.migrations = {
    status: migration.ok ? (migration.outcomes.length ? 'done' : 'skipped') : 'failed',
    detail: migration.ok ? null : `migration ${migration.failedAt} failed`,
    applied: migration.outcomes,
  }
  if (!migration.ok) {
    // An undeployed version exists and the schema is partially migrated. The running version is
    // still correct for the schema it has, so we do NOT deploy.
    result.message =
      `Migration ${migration.failedAt} failed, so the update stopped before deploying. ` +
      'The running version is unchanged and still matches the database. Fix the migration and ' +
      're-run the update — the version already uploaded and the migrations already applied are ' +
      'not repeated.'
    return result
  }

  // Step 3 — deploy the new version. Idempotent: if it is already serving, this is a no-op.
  try {
    const serving = await currentVersionId(client, scriptName)
    if (serving === versionId) {
      result.steps.deployment = { status: 'skipped', detail: 'already deployed' }
    } else {
      await createDeployment(client, scriptName, versionId, `Hedge update to ${manifest.version}`)
      result.steps.deployment = { status: 'done', detail: null }
    }
    result.ok = true
    result.message = `Updated to Hedge ${manifest.version}.`
    return result
  } catch (error) {
    result.steps.deployment = { status: 'failed', detail: describe(error) }
    result.message =
      `The new version uploaded and migrations applied, but the deployment failed: ${describe(error)}. ` +
      'The previous version is still serving. Re-run the update to retry the deployment, or roll ' +
      'back from the Cloudflare dashboard.'
    return result
  }
}

/**
 * Verify everything before mutating anything. A missing token permission fails here, naming what is
 * missing — never half-way through an update.
 */
async function preflight(input: SystemUpdateInput): Promise<Preflight> {
  const client = cloudflareClient(input.accountId, input.token)

  // The token is live at all.
  try {
    const verification = await verifyToken(client)
    if (verification.status !== 'active') {
      throw ApiError.badRequest('The Cloudflare API token is not active.')
    }
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw ApiError.badRequest(
        'The Cloudflare API token could not be verified — check it and the account id.',
      )
    }
    throw error
  }

  // Read the running script's settings. This carries the account-specific bindings and secrets
  // forward, and proves Workers Scripts access — a 403 here names the missing permission.
  let settings: Awaited<ReturnType<typeof readScriptSettings>>
  try {
    settings = await readScriptSettings(client, WORKER_NAME)
  } catch (error) {
    if (error instanceof CloudflareError && error.isAuthFailure) {
      throw ApiError.badRequest(
        'The Cloudflare API token is missing the "Workers Scripts:Edit" permission.',
      )
    }
    if (error instanceof CloudflareError && error.status === 404) {
      throw ApiError.badRequest(
        `No Worker named "${WORKER_NAME}" was found on this account. A renamed deployment can't be updated from here yet.`,
      )
    }
    throw error
  }

  // Refuse to proceed if we couldn't read the current bindings. A version uploaded with an empty
  // binding set drops every binding — losing `AUTH_SECRET` (invalidating every session, invite and
  // key) and the `DB`/`MEDIA` ids. Better to fail the whole update than to carry nothing forward.
  if (settings.bindings.length === 0) {
    throw ApiError.badRequest(
      "Couldn't read the deployment's current bindings from Cloudflare, so the update was stopped to avoid dropping them (including AUTH_SECRET). Nothing was changed.",
    )
  }

  // The D1 database id — from the DB binding, which is exactly the account-specific id
  // `wrangler.jsonc` omits. Probing it read-only proves D1 access before migrations run.
  const dbBinding = settings.bindings.find((b) => b.type === 'd1' && b.name === 'DB')
  const databaseId =
    (typeof dbBinding?.id === 'string' ? dbBinding.id : null) ??
    (await findDatabaseId(client, D1_DATABASE_NAME))
  if (!databaseId)
    throw ApiError.badRequest('Could not resolve the Hedge D1 database on this account.')

  try {
    await d1Query(client, databaseId, 'SELECT 1')
  } catch (error) {
    if (error instanceof CloudflareError && error.isAuthFailure) {
      throw ApiError.badRequest('The Cloudflare API token is missing the "D1:Edit" permission.')
    }
    throw error
  }

  // Fetch and verify the artifact for the target version.
  const artifact = await fetchTargetArtifact(input.targetVersion)
  const wanted = parseVersion(input.targetVersion)
  const got = parseVersion(artifact.manifest.version)
  if (
    !wanted ||
    !got ||
    wanted.major !== got.major ||
    wanted.minor !== got.minor ||
    wanted.patch !== got.patch
  ) {
    throw ApiError.badRequest(
      `The release artifact is version ${artifact.manifest.version}, which doesn't match the requested ${input.targetVersion}.`,
    )
  }

  return {
    client,
    scriptName: WORKER_NAME,
    databaseId,
    currentBindings: settings.bindings,
    artifact,
    tag: input.targetVersion,
  }
}

/** Upload assets (only what changed) then the version, carrying current bindings forward. */
async function uploadNewVersion(pre: Preflight, manifest: HedgeManifest): Promise<string> {
  const { client, scriptName, artifact, currentBindings } = pre

  // Only the assets Cloudflare is missing get uploaded; unchanged files are omitted by the session.
  const session = await createAssetUploadSession(client, scriptName, manifest.files)
  const byHash = new Map(manifest.files.map((file) => [file.hash, file]))
  const completionToken = await uploadAssets(client, session, (hash) => {
    const file = byHash.get(hash)
    const bytes = file && artifact.assetBytes(file.path)
    if (!file || !bytes) throw new Error(`artifact is missing the asset for hash ${hash}`)
    return { bytes, contentType: file.contentType }
  })

  return (
    await uploadVersion(client, scriptName, {
      mainModule: manifest.mainModule,
      modules: artifact.workerModules(),
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      bindings: mergeBindings(currentBindings, manifest),
      assetsJwt: completionToken,
      assetsConfig: {
        html_handling: manifest.assets.htmlHandling,
        not_found_handling: manifest.assets.notFoundHandling,
        run_worker_first: manifest.assets.runWorkerFirst,
      },
      tag: pre.tag,
      message: `Hedge update to ${manifest.version}`,
    })
  ).id
}

/**
 * Carry the running bindings forward (as `inherit`, preserving ids and secret values), then add any
 * binding the new version declares that the deployment doesn't already have — a new `plain_text`
 * var, typically, so an update that introduces one works without the operator editing anything.
 */
function mergeBindings(current: CloudflareBinding[], manifest: HedgeManifest): CloudflareBinding[] {
  const inherited = inheritBindings(current)
  const existingNames = new Set(current.map((b) => b.name))

  const added: CloudflareBinding[] = []
  for (const declared of manifest.bindings) {
    if (existingNames.has(declared.name)) continue
    // Only vars are safe to introduce without an id; a new account-specific binding is Stage 2.
    if (declared.type === 'plain_text') {
      added.push({ type: 'plain_text', name: declared.name, text: declared.text ?? '' })
    }
  }
  return [...inherited, ...added]
}

async function fetchTargetArtifact(tag: string): Promise<Artifact> {
  const release = await githubReleaseByTag(tag)
  const tarball = release.assets.find((a) => a.name.endsWith('.tar.gz'))
  const checksum = release.assets.find((a) => a.name.endsWith('.tar.gz.sha256'))
  if (!tarball || !checksum) {
    throw ApiError.badRequest(`Release ${tag} has no Hedge update artifact attached.`)
  }

  const checksumBody = await (await fetch(checksum.browser_download_url)).text()
  const expected = checksumBody.trim().split(/\s+/)[0] ?? ''
  try {
    return await fetchArtifact(tarball.browser_download_url, expected)
  } catch (error) {
    throw ApiError.badRequest(`Could not verify the release artifact: ${describe(error)}`)
  }
}

interface GithubRelease {
  assets: Array<{ name: string; browser_download_url: string }>
}

async function githubReleaseByTag(tag: string): Promise<GithubRelease> {
  const response = await fetch(`https://api.github.com/repos/${HEDGE_REPO}/releases/tags/${tag}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `hedge-cms/${HEDGE_VERSION}`,
    },
  })
  if (!response.ok) {
    throw ApiError.badRequest(`Could not find release ${tag} upstream (HTTP ${response.status}).`)
  }
  return (await response.json()) as GithubRelease
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
