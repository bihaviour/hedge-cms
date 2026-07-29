import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { HedgeManifest } from '@hedge/core'
import { assetEntry, createTar, type TarEntry } from '../../../scripts/artifact-lib'
import { readArtifact } from './artifact'

/**
 * Round-trips the writer (`scripts/artifact-lib`) through the reader (`@hedge/deploy`): what CI packs
 * is exactly what the Worker unpacks. Uses recorded, in-memory bytes — CI never touches Cloudflare.
 */

const encoder = new TextEncoder()

function buildArtifact(): { gz: Uint8Array; sha256: string; manifest: HedgeManifest } {
  const indexHtml = encoder.encode('<!doctype html><title>Hedge</title>')
  const appJs = encoder.encode('console.log("admin")')

  const manifest: HedgeManifest = {
    version: '9.9.9',
    mainModule: 'index.js',
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: [
      { type: 'd1', name: 'DB' },
      { type: 'plain_text', name: 'APP_NAME', text: 'Hedge' },
    ],
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
    files: [assetEntry('/index.html', indexHtml), assetEntry('/assets/app.js', appJs)],
  }

  const entries: TarEntry[] = [
    { name: 'index.js', data: encoder.encode('export default { fetch() {} }') },
    { name: 'admin/index.html', data: indexHtml },
    { name: 'admin/assets/app.js', data: appJs },
    { name: 'migrations/0000_init.sql', data: encoder.encode('CREATE TABLE t (id text);') },
    { name: 'hedge.json', data: encoder.encode(JSON.stringify(manifest)) },
  ].sort((a, b) => (a.name < b.name ? -1 : 1))

  const gz = gzipSync(createTar(entries))
  return { gz, sha256: createHash('sha256').update(gz).digest('hex'), manifest }
}

describe('readArtifact', () => {
  test('verifies the checksum and exposes the manifest, worker, assets and migrations', async () => {
    const { gz, sha256, manifest } = buildArtifact()
    const artifact = await readArtifact(gz, sha256)

    expect(artifact.manifest).toEqual(manifest)

    const worker = artifact.workerModules()
    expect(worker.map((m) => m.name)).toEqual(['index.js'])

    // Assets resolve by their served path, not their tarball path.
    expect(new TextDecoder().decode(artifact.assetBytes('/index.html')!)).toContain('Hedge')
    expect(artifact.assetBytes('/assets/app.js')).toBeDefined()
    expect(artifact.assetBytes('/missing')).toBeUndefined()

    const migrations = artifact.migrations()
    expect(migrations).toEqual([{ name: '0000_init.sql', sql: 'CREATE TABLE t (id text);' }])
  })

  test('rejects a checksum mismatch rather than trusting the contents', async () => {
    const { gz } = buildArtifact()
    await expect(readArtifact(gz, 'deadbeef'.repeat(8))).rejects.toThrow(/checksum mismatch/)
  })

  test('accepts an uppercase / padded checksum', async () => {
    const { gz, sha256 } = buildArtifact()
    const artifact = await readArtifact(gz, `  ${sha256.toUpperCase()}  `)
    expect(artifact.manifest.version).toBe('9.9.9')
  })
})
