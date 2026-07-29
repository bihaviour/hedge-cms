import type { HedgeBinding, HedgeManifest } from '@hedge/core'
import {
  type Artifact,
  type CloudflareBinding,
  type CloudflareClient,
  CloudflareError,
  createAssetUploadSession,
  createBucket,
  createDatabase,
  enableWorkersDevSubdomain,
  runMigrations,
  scriptExists,
  uploadAssets,
  uploadVersion,
  workersDevSubdomain,
} from '@hedge/deploy'
import type { CreatedResource, InstallResult, InstallStep, StepState } from './protocol'
import { derivedNames, INSTALL_STEPS } from './protocol'

/**
 * Provisioning and first deploy of a Hedge deployment (#38), from a release artifact and a
 * Cloudflare API token — no Git repository, no Workers Builds, no CI.
 *
 * It walks the same endpoints `lib/update.ts` walks, through the same `@hedge/deploy` client, but
 * creates what the updater assumes already exists. The difference in kind is bindings: an update
 * carries the running deployment's bindings forward with `inherit`, because it must not drop
 * `AUTH_SECRET` or the resource ids. An install has nothing to inherit, so it builds the binding set
 * from the artifact's own `hedge.json` — which is what keeps the installer from hardcoding what
 * Hedge needs, and means a future binding does not require an installer release.
 *
 * **This runs on the operator's machine, not on ours.** Spike #37 established that
 * `api.cloudflare.com` serves no CORS headers, so no browser page can call it; the installer's page
 * drives this over `localhost` and the token never leaves the machine it was pasted on. See
 * `docs/spikes/37-browser-cloudflare-api/`.
 */

export interface InstallOptions {
  client: CloudflareClient
  artifact: Artifact
  /** The Worker's script name; D1 and R2 names derive from it. */
  name: string
  appName: string
  emailFrom: string
  emailFromName: string
  onEvent: (event: InstallProgress) => void
}

export type InstallProgress =
  | { type: 'step'; state: StepState }
  | { type: 'resource'; resource: CreatedResource }

/**
 * Whether this name is free to install onto.
 *
 * Asked before anything is created, because uploading a version to a script name someone else's
 * Worker occupies would overwrite it and the operator would find out afterwards. D1 and R2 are not
 * checked the same way: adopting an existing database or bucket of the derived name is exactly what
 * makes a retry safe, and is handled inside `createDatabase` / `createBucket`.
 */
export async function nameAvailable(client: CloudflareClient, name: string): Promise<boolean> {
  return !(await scriptExists(client, derivedNames(name).script))
}

export async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const { client, artifact, onEvent } = options
  const names = derivedNames(options.name)
  const manifest = artifact.manifest

  const steps = new Map<InstallStep, StepState>(
    INSTALL_STEPS.map((step) => [step, { step, status: 'pending', detail: null }]),
  )
  const created: CreatedResource[] = []

  const report = (step: InstallStep, status: StepState['status'], detail: string | null = null) => {
    const state: StepState = { step, status, detail }
    steps.set(step, state)
    onEvent({ type: 'step', state })
  }
  const record = (resource: CreatedResource) => {
    created.push(resource)
    onEvent({ type: 'resource', resource })
  }
  const finish = (ok: boolean, url: string | null, message: string): InstallResult => ({
    ok,
    url,
    version: manifest.version,
    steps: [...steps.values()],
    created,
    message,
  })
  /** Every failure ends the same way: say what broke, and name what already exists. */
  const abort = (step: InstallStep, error: unknown): InstallResult => {
    report(step, 'failed', describe(error))
    return finish(false, null, `${FAILURE_ADVICE[step]} — ${describe(error)}${orphanNote(created)}`)
  }

  // 1 — D1. Idempotent by name, so a retry adopts the database a previous attempt made.
  let databaseId: string
  try {
    report('database', 'running')
    const database = await createDatabase(client, names.database)
    databaseId = database.id
    record({ kind: 'd1', name: names.database, id: database.id, created: database.created })
    report(
      'database',
      database.created ? 'done' : 'skipped',
      database.created ? names.database : `${names.database} already existed and was reused`,
    )
  } catch (error) {
    return abort('database', error)
  }

  // 2 — R2. Same idempotence, and the same reason for it.
  try {
    report('bucket', 'running')
    const bucket = await createBucket(client, names.bucket)
    record({ kind: 'r2', name: names.bucket, created: bucket.created })
    report(
      'bucket',
      bucket.created ? 'done' : 'skipped',
      bucket.created ? names.bucket : `${names.bucket} already existed and was reused`,
    )
  } catch (error) {
    return abort('bucket', error)
  }

  // 3 — Migrations, *before* the Worker exists rather than after it is routable. Issue #38 lists
  // this later in the sequence; running it here means no request can ever reach an un-migrated
  // schema, which is the ordering rule #35 established for updates and is free to honour here.
  try {
    report('migrations', 'running')
    const migrations = artifact.migrations()
    const result = await runMigrations(client, databaseId, migrations)
    if (!result.ok) {
      report('migrations', 'failed', `migration ${result.failedAt} failed`)
      return finish(
        false,
        null,
        `Migration ${result.failedAt} failed, so the install stopped before deploying the Worker. ` +
          `The database exists and is partly migrated. Re-running the install re-uses it and ` +
          `continues from the migration that failed.${orphanNote(created)}`,
      )
    }
    report(
      'migrations',
      result.outcomes.length ? 'done' : 'skipped',
      `${result.outcomes.length} applied`,
    )
  } catch (error) {
    return abort('migrations', error)
  }

  // 4 — Assets. Content-hashed, so a resumed install re-uploads only what Cloudflare is missing.
  let assetsJwt: string
  try {
    report('assets', 'running')
    const session = await createAssetUploadSession(client, names.script, manifest.files)
    const byHash = new Map(manifest.files.map((file) => [file.hash, file]))
    assetsJwt = await uploadAssets(client, session, (hash) => {
      const file = byHash.get(hash)
      const bytes = file && artifact.assetBytes(file.path)
      if (!file || !bytes) throw new Error(`the artifact is missing the asset for hash ${hash}`)
      return { bytes, contentType: file.contentType }
    })
    const pending = session.buckets.reduce((total, bucket) => total + bucket.length, 0)
    report(
      'assets',
      'done',
      `${pending || manifest.files.length} of ${manifest.files.length} uploaded`,
    )
  } catch (error) {
    return abort('assets', error)
  }

  // 5 — The Worker itself. A version and a deployment in one call: there is no running version to
  // stage behind, which is the one place an install is simpler than an update.
  try {
    report('worker', 'running')
    await uploadVersion(client, names.script, {
      mainModule: manifest.mainModule,
      modules: artifact.workerModules(),
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      bindings: installBindings(manifest, {
        databaseId,
        bucketName: names.bucket,
        scriptName: names.script,
        appName: options.appName,
        emailFrom: options.emailFrom,
        emailFromName: options.emailFromName,
      }),
      assetsJwt,
      assetsConfig: {
        html_handling: manifest.assets.htmlHandling,
        not_found_handling: manifest.assets.notFoundHandling,
        run_worker_first: manifest.assets.runWorkerFirst,
      },
      tag: manifest.version,
      message: `Hedge ${manifest.version} installed`,
    })
    record({ kind: 'worker', name: names.script, created: true })
    report('worker', 'done', names.script)
  } catch (error) {
    return abort('worker', error)
  }

  // 6 — Route it. A freshly uploaded Worker answers nothing until its subdomain is enabled, so
  // skipping this would end the install by handing over a URL that 404s.
  let url: string | null = null
  try {
    report('subdomain', 'running')
    await enableWorkersDevSubdomain(client, names.script)
    const subdomain = await workersDevSubdomain(client)
    url = subdomain ? `https://${names.script}.${subdomain}.workers.dev` : null
    report(
      'subdomain',
      'done',
      // An account that has never claimed a workers.dev subdomain has no hostname to offer, and the
      // installer cannot claim one on the operator's behalf — it is an account-wide, one-time name.
      url ?? 'enabled, but this account has no workers.dev subdomain yet',
    )
  } catch (error) {
    report('subdomain', 'failed', describe(error))
    return finish(
      false,
      null,
      `Hedge ${manifest.version} deployed, but making it reachable on workers.dev failed: ` +
        `${describe(error)}. The Worker exists — enable its workers.dev route from the Cloudflare ` +
        `dashboard, or re-run the install.${orphanNote(created)}`,
    )
  }

  return finish(
    true,
    url,
    url
      ? `Hedge ${manifest.version} is installed and running at ${url}.`
      : `Hedge ${manifest.version} is installed. Claim a workers.dev subdomain for this account, ` +
          `or add a custom route, and the deployment is reachable.`,
  )
}

interface BindingContext {
  databaseId: string
  bucketName: string
  scriptName: string
  appName: string
  emailFrom: string
  emailFromName: string
}

/**
 * The binding set for a brand-new deployment, built from what the artifact declares it needs.
 *
 * `hedge.json` carries types and names but never ids — that is the same invariant `wrangler.jsonc`
 * keeps, and it is what makes an artifact built from a tag deployable on anybody's account. So each
 * declaration is filled in here with this account's own values.
 *
 * Two are added when the manifest does not already declare them, and both are deliberate:
 *
 * - **`AUTH_SECRET`**, because it is a secret and secrets are not in `wrangler.jsonc` for the
 *   artifact to carry. Generating it is the single clearest UX win over the deploy button, which
 *   asks a non-technical operator to run `openssl rand -base64 32`.
 * - **`WORKER_NAME`**, because a Worker is not told its own script name at run time and the
 *   dashboard updater (#35) has to find itself on the account. Without it, a deployment installed
 *   under any name but `hedge-cms` could never update from its own admin — and #39 would then be
 *   showing it an update path that does not work, which is the exact failure #39 exists to prevent.
 *
 * **Every binding name appears exactly once.** `wrangler.jsonc` declares `WORKER_NAME` as an empty
 * var, so it arrives in the manifest and is filled in by `varValue` above; appending it again would
 * send Cloudflare the same name twice, once empty, and leave which one wins to the API. The
 * append-if-absent below is what keeps that from depending on the order two files happen to be in.
 */
export function installBindings(manifest: HedgeManifest, ctx: BindingContext): CloudflareBinding[] {
  const bindings: CloudflareBinding[] = []

  for (const declared of manifest.bindings) {
    const binding = bindingFor(declared, ctx)
    if (binding) bindings.push(binding)
  }

  const declaredNames = new Set(bindings.map((binding) => binding.name))
  const addIfAbsent = (binding: CloudflareBinding) => {
    if (!declaredNames.has(binding.name)) bindings.push(binding)
  }

  addIfAbsent({ type: 'secret_text', name: 'AUTH_SECRET', text: generateAuthSecret() })
  addIfAbsent({ type: 'plain_text', name: 'WORKER_NAME', text: ctx.scriptName })
  return bindings
}

function bindingFor(declared: HedgeBinding, ctx: BindingContext): CloudflareBinding | null {
  switch (declared.type) {
    case 'd1':
      return { type: 'd1', name: declared.name, id: ctx.databaseId }
    case 'r2_bucket':
      return { type: 'r2_bucket', name: declared.name, bucket_name: ctx.bucketName }
    case 'send_email':
      // Email works only once a domain is onboarded with `wrangler email sending enable`, which the
      // installer cannot do. The binding is still attached, so nothing has to change later.
      return { type: 'send_email', name: declared.name }
    case 'assets':
      // Reattached through `assets.jwt` on the version upload, never as a binding.
      return null
    case 'plain_text':
      return { type: 'plain_text', name: declared.name, text: varValue(declared, ctx) }
    default:
      // An unrecognised binding type is carried through with whatever the artifact declared, so a
      // future binding that needs no account-specific value works without an installer release.
      return {
        type: declared.type,
        name: declared.name,
        ...(declared.text ? { text: declared.text } : {}),
      }
  }
}

/** The value for a `plain_text` var: what the operator chose, else the artifact's own default. */
function varValue(declared: HedgeBinding, ctx: BindingContext): string {
  switch (declared.name) {
    case 'APP_NAME':
      return ctx.appName || (declared.text ?? '')
    case 'EMAIL_FROM':
      return ctx.emailFrom
    case 'EMAIL_FROM_NAME':
      return ctx.emailFromName || (declared.text ?? '')
    case 'INSTALLED_BY':
      // #39 — the About page reads this to offer the update path that matches. An installer
      // deployment has no repository, so it must never be shown the git fallback.
      return 'installer'
    case 'WORKER_NAME':
      // The name the operator chose, so the deployment can address itself when it updates. Empty in
      // the manifest, because a button or CLI deploy is always the `name` in `wrangler.jsonc`.
      return ctx.scriptName
    case 'PUBLIC_URL':
      // Stays empty, always. The deployment answers on a generated workers.dev hostname, which is
      // exactly the case the request-origin fallback is right for, and a wrong value here 500s every
      // authenticated route while `/api/health` keeps answering `ok`.
      return ''
    case 'REPO_URL':
      // There is no repository. Leaving it empty is what makes the About page tell the truth.
      return ''
    default:
      return declared.text ?? ''
  }
}

/**
 * `AUTH_SECRET` — 32 random bytes, base64, exactly what `openssl rand -base64 32` produces.
 *
 * Generated here and written straight into the binding: it is never shown to the operator, never
 * logged, and never sent back to the page. Nobody needs to know it, and rotating it later signs
 * everyone out and invalidates every API key, so there is nothing useful to do with a copy of it.
 */
function generateAuthSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
}

/** Per-step advice, so a failure says what to do rather than only what broke. */
const FAILURE_ADVICE: Record<InstallStep, string> = {
  database: 'Creating the D1 database failed. Nothing else was created',
  bucket: 'Creating the R2 bucket failed — check that R2 is enabled on this account',
  migrations: 'Applying the database migrations failed',
  assets: 'Uploading the admin interface failed',
  worker: 'Uploading the Worker failed',
  subdomain: 'Making the Worker reachable failed',
}

/**
 * What exists on the account after a failed run. An install that dies half-way and says nothing
 * leaves a database and a bucket the operator pays for and cannot identify; naming them is also what
 * makes a retry obviously safe rather than obviously risky.
 */
function orphanNote(created: CreatedResource[]): string {
  const made = created.filter((resource) => resource.created)
  if (made.length === 0) return ''
  const list = made
    .map((resource) => `${resource.name} (${resource.kind.toUpperCase()})`)
    .join(', ')
  return `\n\nAlready created on your account: ${list}. Re-running the install with the same name re-uses these rather than creating more.`
}

function describe(error: unknown): string {
  if (error instanceof CloudflareError) return error.message
  return error instanceof Error ? error.message : String(error)
}
