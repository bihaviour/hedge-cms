import { describe, expect, test } from 'bun:test'
import type { HedgeManifest } from '@hedge/core'
import { type Artifact, type CloudflareBinding, CloudflareError } from '@hedge/deploy'
import type { InstallProgress } from './install'
import { installBindings, runInstall } from './install'
import type { CreatedResource, InstallStep } from './protocol'

/**
 * A fake Cloudflare account over the HTTP client interface, so the whole install sequence — what it
 * creates, in what order, what it does when a step fails, and what it says it left behind — is
 * testable without touching a real account.
 *
 * `existing` seeds resources a previous attempt already made, which is how a resumed install is
 * exercised. `failOn` makes any request whose path matches throw, standing in for a Cloudflare error
 * at that exact step; `failSql` fails a single statement instead, which is the difference between
 * "D1 is unreachable" and "one migration is broken" — two outcomes the installer reports differently.
 */
function fakeAccount(
  options: { existing?: string[]; failOn?: string; failSql?: string; noSubdomain?: boolean } = {},
) {
  const existing = new Set(options.existing ?? [])
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  let uploaded: { bindings: CloudflareBinding[] } | null = null

  const maybeFail = (path: string) => {
    if (options.failOn && path.includes(options.failOn)) {
      throw new CloudflareError(500, [], 'Cloudflare said no')
    }
  }

  const client = {
    accountId: 'acct',
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body })
      maybeFail(path)

      // Script existence — 404 unless a previous run made it.
      if (method === 'GET' && /\/workers\/scripts\/[^/]+\/settings$/.test(path)) {
        if (!existing.has('worker')) throw new CloudflareError(404, [], 'not found')
        return {} as T
      }
      if (method === 'GET' && path.startsWith('/accounts/acct/d1/database?')) {
        return (existing.has('d1') ? [{ uuid: 'db-existing', name: 'demo-db' }] : []) as T
      }
      if (method === 'POST' && path === '/accounts/acct/d1/database') {
        existing.add('d1')
        return { uuid: 'db-new' } as T
      }
      if (method === 'GET' && path.startsWith('/accounts/acct/r2/buckets/')) {
        if (!existing.has('r2')) throw new CloudflareError(404, [], 'not found')
        return {} as T
      }
      if (method === 'POST' && path === '/accounts/acct/r2/buckets') {
        existing.add('r2')
        return {} as T
      }
      // D1 query API — the migration runner.
      if (path.includes('/d1/database/') && path.endsWith('/query')) {
        const { sql } = body as { sql: string }
        if (options.failSql && sql.includes(options.failSql)) {
          throw new CloudflareError(500, [], 'near "CREATE": syntax error')
        }
        if (/SELECT name FROM d1_migrations/.test(sql)) {
          return [{ results: [], success: true, meta: {} }] as T
        }
        return [{ results: [], success: true, meta: {} }] as T
      }
      if (path.endsWith('/assets-upload-session')) {
        // No buckets: nothing to upload, and the session jwt is already the completion token.
        return { jwt: 'completion-token', buckets: [] } as T
      }
      // Checked before the script-level `/subdomain` below, which this path also ends with.
      if (path === '/accounts/acct/workers/subdomain') {
        return (options.noSubdomain ? {} : { subdomain: 'demo-account' }) as T
      }
      if (path.endsWith('/subdomain')) return {} as T
      return {} as T
    },
    async requestForm<T>(method: string, path: string, form: FormData): Promise<T> {
      calls.push({ method, path })
      maybeFail(path)
      if (path.endsWith('/versions')) {
        const metadata = JSON.parse(await (form.get('metadata') as Blob).text())
        uploaded = { bindings: metadata.bindings }
        return { id: 'version-1' } as T
      }
      return {} as T
    },
  }

  return { client, calls, uploaded: () => uploaded }
}

const MANIFEST: HedgeManifest = {
  version: '9.9.9',
  mainModule: 'index.js',
  compatibilityDate: '2026-07-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings: [
    { type: 'd1', name: 'DB' },
    { type: 'r2_bucket', name: 'MEDIA' },
    { type: 'send_email', name: 'EMAIL' },
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
    { type: 'plain_text', name: 'APP_NAME', text: 'Hedge' },
    { type: 'plain_text', name: 'PUBLIC_URL', text: '' },
    { type: 'plain_text', name: 'EMAIL_FROM', text: '' },
    { type: 'plain_text', name: 'EMAIL_FROM_NAME', text: 'Hedge CMS' },
    { type: 'plain_text', name: 'REPO_URL', text: '' },
    { type: 'plain_text', name: 'INSTALLED_BY', text: '' },
    // Declared empty in `wrangler.jsonc`, so it reaches the manifest — the installer must fill it
    // in rather than appending a second binding of the same name.
    { type: 'plain_text', name: 'WORKER_NAME', text: '' },
  ],
  assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
  files: [],
}

const artifact: Artifact = {
  manifest: MANIFEST,
  files: new Map(),
  workerModules: () => [
    { name: 'index.js', content: new TextEncoder().encode('export default {}') },
  ],
  assetBytes: () => undefined,
  migrations: () => [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id text);' }],
}

function install(client: unknown, overrides: Partial<Parameters<typeof runInstall>[0]> = {}) {
  const events: InstallProgress[] = []
  const promise = runInstall({
    // biome-ignore lint/suspicious/noExplicitAny: the fake implements the client surface it uses.
    client: client as any,
    artifact,
    name: 'demo',
    appName: 'Acme Docs',
    emailFrom: '',
    emailFromName: '',
    onEvent: (event) => events.push(event),
    ...overrides,
  })
  return { promise, events }
}

const bindingByName = (bindings: CloudflareBinding[], name: string) =>
  bindings.find((binding) => binding.name === name)

describe('runInstall', () => {
  test('provisions, migrates, deploys and hands back a URL', async () => {
    const account = fakeAccount()
    const { promise, events } = install(account.client)
    const result = await promise

    expect(result.ok).toBe(true)
    expect(result.url).toBe('https://demo.demo-account.workers.dev')
    expect(result.version).toBe('9.9.9')
    expect(result.steps.every((step) => step.status === 'done' || step.status === 'skipped')).toBe(
      true,
    )

    const stepOrder = events
      .filter((event) => event.type === 'step' && event.state.status === 'running')
      .map((event) => (event.type === 'step' ? event.state.step : null))
    expect(stepOrder).toEqual([
      'database',
      'bucket',
      'migrations',
      'assets',
      'worker',
      'subdomain',
    ] satisfies InstallStep[])
  })

  test('migrations run before the Worker is uploaded, so nothing can serve an un-migrated schema', async () => {
    const account = fakeAccount()
    await install(account.client).promise

    const migration = account.calls.findIndex((call) => call.path.endsWith('/query'))
    const upload = account.calls.findIndex((call) => call.path.endsWith('/versions'))
    expect(migration).toBeGreaterThanOrEqual(0)
    expect(upload).toBeGreaterThan(migration)
  })

  test('derives the D1 and R2 names from the deployment name', async () => {
    const account = fakeAccount()
    await install(account.client).promise

    expect(account.calls).toContainEqual({
      method: 'POST',
      path: '/accounts/acct/d1/database',
      body: { name: 'demo-db' },
    })
    expect(account.calls).toContainEqual({
      method: 'POST',
      path: '/accounts/acct/r2/buckets',
      body: { name: 'demo-media' },
    })
  })

  test('re-uses a database and bucket a previous attempt left behind', async () => {
    const account = fakeAccount({ existing: ['d1', 'r2'] })
    const result = await install(account.client).promise

    expect(result.ok).toBe(true)
    // Nothing was created a second time — the resumed run adopted both.
    expect(result.created.filter((resource) => resource.created)).toHaveLength(1)
    expect(result.created.find((r) => r.kind === 'd1')).toMatchObject({ created: false })
    expect(account.calls.some((call) => call.path === '/accounts/acct/d1/database')).toBe(false)
  })

  test('names what it already created when a later step fails', async () => {
    // The bucket and database exist by the time the version upload is attempted.
    const account = fakeAccount({ failOn: '/versions' })
    const result = await install(account.client).promise

    expect(result.ok).toBe(false)
    expect(result.message).toContain('demo-db (D1)')
    expect(result.message).toContain('demo-media (R2)')
    expect(result.message).toContain('re-uses these rather than creating more')
    expect(result.steps.find((step) => step.step === 'worker')?.status).toBe('failed')
  })

  test('stops before deploying when a migration fails, and says the database is partly migrated', async () => {
    const account = fakeAccount({ failSql: 'CREATE TABLE a' })
    const result = await install(account.client).promise

    expect(result.ok).toBe(false)
    expect(result.steps.find((step) => step.step === 'migrations')?.status).toBe('failed')
    expect(account.calls.some((call) => call.path.endsWith('/versions'))).toBe(false)
    expect(result.message).toContain('0000_init.sql')
  })

  test('reports success without a URL when the account has no workers.dev subdomain', async () => {
    const account = fakeAccount({ noSubdomain: true })
    const result = await install(account.client).promise

    expect(result.ok).toBe(true)
    expect(result.url).toBeNull()
    expect(result.message).toContain('Claim a workers.dev subdomain')
  })
})

describe('installBindings', () => {
  const ctx = {
    databaseId: 'db-123',
    bucketName: 'demo-media',
    scriptName: 'demo',
    appName: 'Acme Docs',
    emailFrom: 'hello@acme.test',
    emailFromName: 'Acme',
  }

  test('fills the account-specific values the manifest deliberately omits', () => {
    const bindings = installBindings(MANIFEST, ctx)

    expect(bindingByName(bindings, 'DB')).toEqual({ type: 'd1', name: 'DB', id: 'db-123' })
    expect(bindingByName(bindings, 'MEDIA')).toEqual({
      type: 'r2_bucket',
      name: 'MEDIA',
      bucket_name: 'demo-media',
    })
    expect(bindingByName(bindings, 'EMAIL')).toEqual({ type: 'send_email', name: 'EMAIL' })
  })

  test('generates AUTH_SECRET as a secret, 32 bytes of base64', () => {
    const secret = bindingByName(installBindings(MANIFEST, ctx), 'AUTH_SECRET')

    expect(secret?.type).toBe('secret_text')
    const text = secret?.text as string
    expect(text).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(atob(text)).toHaveLength(32)
  })

  test('a second install gets a different AUTH_SECRET', () => {
    const first = bindingByName(installBindings(MANIFEST, ctx), 'AUTH_SECRET')?.text
    const second = bindingByName(installBindings(MANIFEST, ctx), 'AUTH_SECRET')?.text
    expect(first).not.toBe(second)
  })

  test('records how it was installed, so the About page offers a path that exists (#39)', () => {
    expect(bindingByName(installBindings(MANIFEST, ctx), 'INSTALLED_BY')?.text).toBe('installer')
  })

  test('records the script name, so the deployment can update itself under a custom name', () => {
    expect(bindingByName(installBindings(MANIFEST, ctx), 'WORKER_NAME')?.text).toBe('demo')
  })

  test('never sends a binding name twice, whatever the manifest declares', () => {
    // `WORKER_NAME` is declared in `wrangler.jsonc` *and* added by the installer; `AUTH_SECRET` is
    // added only by the installer. Sending either name twice would leave which value wins to
    // Cloudflare, and one of the two is always the empty one.
    for (const manifest of [MANIFEST, { ...MANIFEST, bindings: [] }]) {
      const names = installBindings(manifest, ctx).map((binding) => binding.name)
      expect(names).toEqual([...new Set(names)])
    }
  })

  test('still supplies AUTH_SECRET and WORKER_NAME when the manifest declares neither', () => {
    const bare: HedgeManifest = { ...MANIFEST, bindings: [] }
    const bindings = installBindings(bare, ctx)
    expect(bindingByName(bindings, 'AUTH_SECRET')?.type).toBe('secret_text')
    expect(bindingByName(bindings, 'WORKER_NAME')?.text).toBe('demo')
  })

  test('leaves PUBLIC_URL and REPO_URL empty', () => {
    const bindings = installBindings(MANIFEST, ctx)
    // A wrong PUBLIC_URL 500s every authenticated route while /api/health keeps answering ok, and
    // the generated workers.dev hostname is exactly what the request-origin fallback is for.
    expect(bindingByName(bindings, 'PUBLIC_URL')?.text).toBe('')
    // There is no repository. Empty is what keeps the About page truthful.
    expect(bindingByName(bindings, 'REPO_URL')?.text).toBe('')
  })

  test("takes the operator's choices over the artifact defaults", () => {
    const bindings = installBindings(MANIFEST, ctx)
    expect(bindingByName(bindings, 'APP_NAME')?.text).toBe('Acme Docs')
    expect(bindingByName(bindings, 'EMAIL_FROM')?.text).toBe('hello@acme.test')
    expect(bindingByName(bindings, 'EMAIL_FROM_NAME')?.text).toBe('Acme')
    // Untouched by the operator: the artifact's own default carries through.
    expect(bindingByName(bindings, 'ENVIRONMENT')?.text).toBe('production')
  })

  test('never sends the assets binding — a version reattaches assets through its jwt', () => {
    expect(bindingByName(installBindings(MANIFEST, ctx), 'ASSETS')).toBeUndefined()
  })

  test('carries an unrecognised future binding through rather than dropping it', () => {
    const manifest: HedgeManifest = {
      ...MANIFEST,
      bindings: [...MANIFEST.bindings, { type: 'analytics_engine', name: 'METRICS' }],
    }
    expect(bindingByName(installBindings(manifest, ctx), 'METRICS')).toEqual({
      type: 'analytics_engine',
      name: 'METRICS',
    })
  })
})

describe('created resources', () => {
  test('every resource is reported as it happens, not only at the end', async () => {
    const account = fakeAccount()
    const { promise, events } = install(account.client)
    await promise

    const resources = events
      .filter((event): event is { type: 'resource'; resource: CreatedResource } =>
        Boolean(event.type === 'resource'),
      )
      .map((event) => event.resource.kind)
    expect(resources).toEqual(['d1', 'r2', 'worker'])
  })
})
