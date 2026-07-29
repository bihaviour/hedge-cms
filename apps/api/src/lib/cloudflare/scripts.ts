import type { CloudflareClient } from './client'

/**
 * The Workers Scripts endpoints an update walks: read the running script's settings (to carry its
 * bindings and secrets forward), upload a new *version* without deploying it, then create a
 * deployment that points at that version. Rollback is just another deployment at an older version.
 *
 * The version/deployment split is the whole point of the update sequence: a version can be uploaded
 * and migrations applied against it before any traffic is moved, so new code never serves against an
 * old schema. See `.claude/rules/workers-config.md` and issue #35.
 */

/** A binding as the settings endpoint returns it and a version upload accepts it. */
export interface CloudflareBinding {
  type: string
  name: string
  // `text` for plain_text vars; ids for d1/r2/etc. Secrets return no value — see `inheritBindings`.
  [key: string]: unknown
}

export interface ScriptSettings {
  bindings: CloudflareBinding[]
  compatibilityDate: string | null
  compatibilityFlags: string[]
}

/**
 * Read the running script's settings. The bindings here are the account-specific truth — the `DB`
 * and `MEDIA` ids `wrangler.jsonc` deliberately omits, and `AUTH_SECRET` (returned nameless-only,
 * its value withheld). A version upload that doesn't reproduce them drops them, which is the single
 * most destructive thing an update can do, so the route reads this first and merges.
 */
export async function readScriptSettings(
  client: CloudflareClient,
  scriptName: string,
): Promise<ScriptSettings> {
  const result = await client.request<{
    bindings?: CloudflareBinding[]
    compatibility_date?: string
    compatibility_flags?: string[]
  }>('GET', `/accounts/${client.accountId}/workers/scripts/${scriptName}/settings`)

  return {
    bindings: result.bindings ?? [],
    compatibilityDate: result.compatibility_date ?? null,
    compatibilityFlags: result.compatibility_flags ?? [],
  }
}

/**
 * Turn the running bindings into the form a new version reuses them by.
 *
 * `inherit` tells Cloudflare "keep whatever the previous version had under this name" — the only way
 * to carry a secret forward without its value, and it preserves the `DB`/`MEDIA` ids too. `assets`
 * is not inherited: a version reattaches its assets through `assets.jwt`, so it is dropped here and
 * handled separately.
 */
export function inheritBindings(bindings: CloudflareBinding[]): CloudflareBinding[] {
  return bindings
    .filter((binding) => binding.type !== 'assets')
    .map((binding) => ({ type: 'inherit', name: binding.name }))
}

export interface UploadVersionInput {
  /** The entry module's name inside `modules`, e.g. `index.js`. */
  mainModule: string
  /** The Worker's ES modules, by name. */
  modules: Array<{ name: string; content: string | Uint8Array }>
  compatibilityDate: string
  compatibilityFlags: string[]
  bindings: CloudflareBinding[]
  /** The completion token from the asset upload session — reattaches the SPA to the new version. */
  assetsJwt: string
  assetsConfig: {
    html_handling?: string
    not_found_handling?: string
    run_worker_first?: string[]
  }
  /** A stable tag stamped on the version, so a resumed update finds it instead of uploading twice. */
  tag: string
  message: string
}

export interface WorkerVersion {
  id: string
  number?: number
}

/**
 * Upload a new version **without deploying it**. The version exists and is addressable, but no
 * deployment points at it yet, so traffic still hits the old one until `createDeployment`.
 */
export async function uploadVersion(
  client: CloudflareClient,
  scriptName: string,
  input: UploadVersionInput,
): Promise<WorkerVersion> {
  const metadata = {
    main_module: input.mainModule,
    compatibility_date: input.compatibilityDate,
    compatibility_flags: input.compatibilityFlags,
    bindings: input.bindings,
    assets: { jwt: input.assetsJwt, config: input.assetsConfig },
    annotations: {
      'workers/tag': input.tag,
      'workers/message': input.message,
    },
  }

  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  for (const mod of input.modules) {
    form.append(
      mod.name,
      new Blob([mod.content], { type: 'application/javascript+module' }),
      mod.name,
    )
  }

  return client.requestForm<WorkerVersion>(
    'POST',
    `/accounts/${client.accountId}/workers/scripts/${scriptName}/versions`,
    form,
  )
}

/**
 * The version carrying a given tag, or null. This is what makes the version step idempotent: a
 * resumed update finds the version it already uploaded rather than stacking a duplicate.
 */
export async function findVersionByTag(
  client: CloudflareClient,
  scriptName: string,
  tag: string,
): Promise<string | null> {
  const result = await client.request<{
    items?: Array<{ id: string; annotations?: Record<string, string> }>
  }>('GET', `/accounts/${client.accountId}/workers/scripts/${scriptName}/versions`)

  const match = (result.items ?? []).find((item) => item.annotations?.['workers/tag'] === tag)
  return match?.id ?? null
}

export interface Deployment {
  id: string
  versions: Array<{ version_id: string; percentage: number }>
  created_on?: string
}

/** Deployments newest first — the first entry is what is serving now. */
export async function listDeployments(
  client: CloudflareClient,
  scriptName: string,
): Promise<Deployment[]> {
  const result = await client.request<{ deployments?: Deployment[] }>(
    'GET',
    `/accounts/${client.accountId}/workers/scripts/${scriptName}/deployments`,
  )
  return result.deployments ?? []
}

/** The version id serving 100% of traffic now, or null when it can't be determined. */
export async function currentVersionId(
  client: CloudflareClient,
  scriptName: string,
): Promise<string | null> {
  const [latest] = await listDeployments(client, scriptName)
  if (!latest) return null
  // A simple single-version deployment is the only shape Hedge ever creates.
  return latest.versions.find((v) => v.percentage === 100)?.version_id ?? null
}

/** Point a new deployment at a version — the step that actually moves traffic. Also used to roll back. */
export async function createDeployment(
  client: CloudflareClient,
  scriptName: string,
  versionId: string,
  message: string,
): Promise<{ id: string }> {
  return client.request<{ id: string }>(
    'POST',
    `/accounts/${client.accountId}/workers/scripts/${scriptName}/deployments`,
    {
      strategy: 'percentage',
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { 'workers/message': message },
    },
  )
}
