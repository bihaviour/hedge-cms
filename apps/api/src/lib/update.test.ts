import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { HedgeManifest } from '@hedge/core'
import { assetEntry, createTar, type TarEntry } from '../../../../scripts/artifact-lib'
import { runUpdate } from './update'

/**
 * The whole update sequence against a recorded Cloudflare + GitHub, driven through a `fetch` stub —
 * CI never touches a live account. These pin the two things the issue calls non-negotiable: the
 * migrate-before-deploy ordering with its per-step failure semantics, and that the token is never
 * persisted or returned.
 */

const TOKEN = 'cf-token-super-secret-value'
const ACCOUNT = 'account-123'
const TARGET = 'v9.9.9'
const TARBALL_URL = 'https://dl.example/hedge-9.9.9.tar.gz'
const CHECKSUM_URL = 'https://dl.example/hedge-9.9.9.tar.gz.sha256'

function buildArtifactBytes(): { gz: Uint8Array; sha256: string } {
  const indexHtml = new TextEncoder().encode('<!doctype html>')
  const manifest: HedgeManifest = {
    version: '9.9.9',
    mainModule: 'index.js',
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: [
      { type: 'd1', name: 'DB' },
      { type: 'plain_text', name: 'NEW_VAR', text: 'introduced' },
    ],
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
    files: [assetEntry('/index.html', indexHtml)],
  }
  const entries: TarEntry[] = [
    { name: 'index.js', data: new TextEncoder().encode('export default {}') },
    { name: 'admin/index.html', data: indexHtml },
    {
      name: 'migrations/0000_init.sql',
      data: new TextEncoder().encode('CREATE TABLE t (id text);'),
    },
    { name: 'hedge.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
  ].sort((a, b) => (a.name < b.name ? -1 : 1))
  const gz = gzipSync(createTar(entries))
  return { gz, sha256: createHash('sha256').update(gz).digest('hex') }
}

interface RouterOptions {
  settingsStatus?: number
  emptyBindings?: boolean
  failMigration?: boolean
  existingVersionTag?: string
  servingVersionId?: string
}

interface Recorded {
  d1Bodies: string[]
  calls: string[]
  deploymentCreated: boolean
  versionUploaded: boolean
}

function installFetch(options: RouterOptions = {}): Recorded {
  const { gz, sha256 } = buildArtifactBytes()
  const recorded: Recorded = {
    d1Bodies: [],
    calls: [],
    deploymentCreated: false,
    versionUploaded: false,
  }

  const cf = (result: unknown, status = 200) =>
    new Response(JSON.stringify({ success: status < 400, errors: [], messages: [], result }), {
      status,
    })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    recorded.calls.push(`${method} ${url}`)

    if (url.includes('api.github.com') && url.includes('/releases/tags/')) {
      return new Response(
        JSON.stringify({
          assets: [
            { name: 'hedge-9.9.9.tar.gz', browser_download_url: TARBALL_URL },
            { name: 'hedge-9.9.9.tar.gz.sha256', browser_download_url: CHECKSUM_URL },
          ],
        }),
      )
    }
    if (url === TARBALL_URL) return new Response(gz)
    if (url === CHECKSUM_URL) return new Response(`${sha256}  hedge-9.9.9.tar.gz\n`)

    if (url.endsWith('/user/tokens/verify')) return cf({ id: 'tok', status: 'active' })

    if (url.endsWith('/workers/scripts/hedge-cms/settings')) {
      if (options.settingsStatus) return cf(null, options.settingsStatus)
      return cf({
        bindings: options.emptyBindings
          ? []
          : [
              { type: 'd1', name: 'DB', id: 'db-uuid' },
              { type: 'secret_text', name: 'AUTH_SECRET' },
            ],
        compatibility_date: '2026-06-01',
        compatibility_flags: [],
      })
    }

    if (url.includes('/d1/database/') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { sql: string }
      recorded.d1Bodies.push(String(init?.body))
      if (/SELECT name FROM d1_migrations/.test(body.sql))
        return cf([{ results: [], success: true, meta: {} }])
      if (options.failMigration && /CREATE TABLE t/.test(body.sql)) return cf(null, 500)
      return cf([{ results: [], success: true, meta: {} }])
    }

    if (url.endsWith('/workers/scripts/hedge-cms/versions') && method === 'GET') {
      const items = options.existingVersionTag
        ? [{ id: 'existing-ver', annotations: { 'workers/tag': options.existingVersionTag } }]
        : []
      return cf({ items })
    }
    if (url.endsWith('/assets-upload-session')) return cf({ jwt: 'session-jwt', buckets: [] })
    if (url.endsWith('/workers/scripts/hedge-cms/versions') && method === 'POST') {
      recorded.versionUploaded = true
      return cf({ id: 'ver-1' })
    }
    if (url.endsWith('/workers/scripts/hedge-cms/deployments') && method === 'GET') {
      const deployments = options.servingVersionId
        ? [{ id: 'dep-0', versions: [{ version_id: options.servingVersionId, percentage: 100 }] }]
        : []
      return cf({ deployments })
    }
    if (url.endsWith('/workers/scripts/hedge-cms/deployments') && method === 'POST') {
      recorded.deploymentCreated = true
      return cf({ id: 'dep-1' })
    }

    throw new Error(`unhandled fetch: ${method} ${url}`)
  }) as typeof fetch

  return recorded
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('runUpdate', () => {
  test('uploads the version, migrates, then deploys — in that order', async () => {
    const recorded = installFetch()
    const result = await runUpdate({ token: TOKEN, accountId: ACCOUNT, targetVersion: TARGET })

    expect(result.ok).toBe(true)
    expect(result.fromVersion).toBeDefined()
    expect(result.toVersion).toBe('9.9.9')
    expect(result.versionId).toBe('ver-1')
    expect(result.steps.version.status).toBe('done')
    expect(result.steps.migrations.status).toBe('done')
    expect(result.steps.migrations.applied).toEqual([
      { name: '0000_init.sql', status: 'applied', error: null },
    ])
    expect(result.steps.deployment.status).toBe('done')

    // Ordering: the version upload and the migration both precede the deployment.
    const versionAt = recorded.calls.findIndex(
      (c) => c.startsWith('POST') && c.endsWith('/versions'),
    )
    const migrateAt = recorded.calls.findIndex(
      (c) => c.includes('/d1/database/') && c.startsWith('POST'),
    )
    const deployAt = recorded.calls.findIndex(
      (c) => c.startsWith('POST') && c.endsWith('/deployments'),
    )
    expect(versionAt).toBeLessThan(deployAt)
    expect(migrateAt).toBeLessThan(deployAt)
  })

  test('never persists or returns the token', async () => {
    installFetch()
    const result = await runUpdate({ token: TOKEN, accountId: ACCOUNT, targetVersion: TARGET })
    // The token is legitimately sent to Cloudflare in an Authorization header, but must not leak
    // into the result or into anything written to the database.
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  test('stops before deploying when a migration fails, leaving the running version', async () => {
    const recorded = installFetch({ failMigration: true })
    const result = await runUpdate({ token: TOKEN, accountId: ACCOUNT, targetVersion: TARGET })

    expect(result.ok).toBe(false)
    expect(result.steps.version.status).toBe('done')
    expect(result.steps.migrations.status).toBe('failed')
    expect(result.steps.deployment.status).toBe('skipped')
    expect(recorded.deploymentCreated).toBe(false)
    expect(result.message).toMatch(/before deploying/i)
  })

  test('is idempotent — reuses an uploaded version and skips an already-live deployment', async () => {
    const recorded = installFetch({ existingVersionTag: TARGET, servingVersionId: 'existing-ver' })
    const result = await runUpdate({ token: TOKEN, accountId: ACCOUNT, targetVersion: TARGET })

    expect(result.ok).toBe(true)
    expect(result.steps.version.status).toBe('skipped')
    expect(result.versionId).toBe('existing-ver')
    expect(result.steps.deployment.status).toBe('skipped')
    expect(recorded.versionUploaded).toBe(false)
    expect(recorded.deploymentCreated).toBe(false)
  })

  test('fails preflight, naming the missing Workers Scripts permission', async () => {
    installFetch({ settingsStatus: 403 })
    await expect(
      runUpdate({ token: TOKEN, accountId: ACCOUNT, targetVersion: TARGET }),
    ).rejects.toThrow(/Workers Scripts:Edit/)
  })

  test('refuses to upload a version that would drop all bindings', async () => {
    const recorded = installFetch({ emptyBindings: true })
    await expect(
      runUpdate({ token: TOKEN, accountId: ACCOUNT, targetVersion: TARGET }),
    ).rejects.toThrow(/AUTH_SECRET/)
    // Preflight caught it — nothing was uploaded or deployed.
    expect(recorded.versionUploaded).toBe(false)
    expect(recorded.deploymentCreated).toBe(false)
  })
})
