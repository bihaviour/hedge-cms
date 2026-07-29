#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { HedgeManifest } from '../packages/core/src/system'
import { HEDGE_VERSION } from '../packages/core/src/version'
import {
  assetEntry,
  bindingDeclarations,
  createTar,
  parseJsonc,
  type TarEntry,
} from './artifact-lib'

/**
 * Builds `hedge-<version>.tar.gz` and its checksum — the artifact the in-Worker updater deploys from
 * (#32). Run in CI on release publish, after `bun run build`. The output is reproducible from the
 * tag alone: no mtimes, no machine paths, files emitted in sorted order.
 *
 * The tarball carries the built Worker bundle at its root, the built SPA under `admin/`, the
 * migrations under `migrations/`, and `hedge.json` — the manifest with everything the updater would
 * otherwise have to infer from `wrangler.jsonc`, including a precomputed hash per asset so the Worker
 * never hashes the SPA inside a request budget.
 */

const ROOT = join(import.meta.dir, '..')
const OUT_DIR = join(ROOT, process.argv[2] ?? 'artifact')

function run(): void {
  const wrangler = parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')) as WranglerConfig

  const workerModules = buildWorkerBundle()
  const assets = collectAssets()
  const migrations = collectMigrations()

  const manifest: HedgeManifest = {
    version: HEDGE_VERSION,
    mainModule: 'index.js',
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags ?? [],
    bindings: bindingDeclarations(wrangler),
    assets: {
      notFoundHandling: wrangler.assets?.not_found_handling ?? 'none',
      runWorkerFirst: wrangler.assets?.run_worker_first ?? [],
      ...(wrangler.assets?.html_handling ? { htmlHandling: wrangler.assets.html_handling } : {}),
    },
    files: assets.map((asset) => asset.entry),
  }

  // Assemble the tar. Sort so the bytes are deterministic regardless of directory read order.
  const entries: TarEntry[] = [
    ...workerModules,
    ...assets.map((asset) => ({ name: `admin${asset.entry.path}`, data: asset.data })),
    ...migrations,
    {
      name: 'hedge.json',
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const tar = createTar(entries)
  const gz = gzipSync(tar, { level: 9 })
  const sha256 = createHash('sha256').update(gz).digest('hex')

  const tarballName = `hedge-${HEDGE_VERSION}.tar.gz`
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, tarballName), gz)
  // sha256sum format, so `sha256sum -c` verifies it and the updater reads the leading hex.
  writeFileSync(join(OUT_DIR, `${tarballName}.sha256`), `${sha256}  ${tarballName}\n`)

  const totalAssets = assets.length
  console.log(`Wrote ${tarballName} (${(gz.length / 1024).toFixed(0)} KiB gzipped)`)
  console.log(`  worker modules: ${workerModules.length}`)
  console.log(`  admin assets:   ${totalAssets}`)
  console.log(`  migrations:     ${migrations.length}`)
  console.log(`  sha256:         ${sha256}`)
}

/** Bundle the Worker with wrangler's dry-run into a temp dir, then read the emitted modules. */
function buildWorkerBundle(): TarEntry[] {
  const outdir = mkdtempSync(join(tmpdir(), 'hedge-worker-'))
  // wrangler is installed in apps/api; the config path is relative to that cwd.
  const result = spawnSync(
    'bunx',
    ['wrangler', 'deploy', '--config', '../../wrangler.jsonc', '--dry-run', '--outdir', outdir],
    {
      cwd: join(ROOT, 'apps', 'api'),
      stdio: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  )
  if (result.status !== 0) throw new Error('wrangler dry-run failed to bundle the Worker')

  const modules: TarEntry[] = []
  for (const name of readdirSync(outdir)) {
    // The bundle's `.js` (and any wasm/chunks); not the source map or wrangler's README.
    if (name.endsWith('.map') || name === 'README.md') continue
    modules.push({ name, data: new Uint8Array(readFileSync(join(outdir, name))) })
  }
  if (!modules.some((m) => m.name === 'index.js')) {
    throw new Error('worker bundle is missing index.js — the manifest mainModule')
  }
  return modules
}

/** Every file under the built SPA, as manifest entries plus their bytes. */
function collectAssets(): Array<{ entry: ReturnType<typeof assetEntry>; data: Uint8Array }> {
  const dist = join(ROOT, 'apps', 'admin', 'dist')
  const out: Array<{ entry: ReturnType<typeof assetEntry>; data: Uint8Array }> = []
  for (const path of walk(dist)) {
    const data = new Uint8Array(readFileSync(path))
    // Served path: leading slash, forward slashes, relative to the dist root.
    const served = `/${relative(dist, path).split(/[\\/]/).join('/')}`
    out.push({ entry: assetEntry(served, data), data })
  }
  return out
}

function collectMigrations(): TarEntry[] {
  const dir = join(ROOT, 'apps', 'api', 'migrations')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name: `migrations/${name}`,
      data: new Uint8Array(readFileSync(join(dir, name))),
    }))
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

interface WranglerConfig {
  compatibility_date: string
  compatibility_flags?: string[]
  assets?: {
    binding?: string
    html_handling?: string
    not_found_handling?: string
    run_worker_first?: string[]
  }
  d1_databases?: Array<{ binding: string }>
  r2_buckets?: Array<{ binding: string }>
  send_email?: Array<{ name: string }>
  vars?: Record<string, string>
}

run()
