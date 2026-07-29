import { describe, expect, test } from 'bun:test'
import { assetHash, bindingDeclarations, contentTypeFor, parseJsonc } from './artifact-lib'

const encoder = new TextEncoder()

describe('assetHash — wrangler compatibility', () => {
  // Pinned values: sha256(base64("hello") + extension).slice(0, 32). If these change, the manifest
  // stops matching Cloudflare's upload session and every asset re-uploads on every update, silently.
  test('matches the sha256(base64(contents) + extension) algorithm exactly', () => {
    expect(assetHash(encoder.encode('hello'), '/app.js')).toBe('5d81cb7e2afd1222f0934e57f4fb0db8')
    expect(assetHash(encoder.encode('hello'), '/app.css')).toBe('76e0cb1d9afc75c891dc20261a6eff05')
  })

  test('is 32 hex characters', () => {
    expect(assetHash(encoder.encode('x'), '/a.js')).toMatch(/^[0-9a-f]{32}$/)
  })

  test('depends on the extension — the same bytes at two paths hash differently', () => {
    const bytes = encoder.encode('same')
    expect(assetHash(bytes, '/a.js')).not.toBe(assetHash(bytes, '/a.css'))
  })
})

describe('contentTypeFor', () => {
  test('derives the served content type from the path', () => {
    expect(contentTypeFor('/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/assets/app.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/favicon.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('/x.unknown')).toBe('application/octet-stream')
  })
})

describe('parseJsonc', () => {
  test('strips comments and trailing commas, keeping // inside strings', () => {
    const parsed = parseJsonc(`{
      // a line comment
      "url": "https://example.com", /* block */
      "list": [1, 2,],
    }`) as { url: string; list: number[] }
    expect(parsed.url).toBe('https://example.com')
    expect(parsed.list).toEqual([1, 2])
  })
})

describe('bindingDeclarations', () => {
  test('emits types and names, and var text, but never an id', () => {
    const bindings = bindingDeclarations({
      d1_databases: [{ binding: 'DB' }],
      r2_buckets: [{ binding: 'MEDIA' }],
      assets: { binding: 'ASSETS' },
      vars: { APP_NAME: 'Hedge' },
    })
    expect(bindings).toEqual([
      { type: 'd1', name: 'DB' },
      { type: 'r2_bucket', name: 'MEDIA' },
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: 'APP_NAME', text: 'Hedge' },
    ])
    for (const binding of bindings) expect(binding).not.toHaveProperty('id')
  })
})
