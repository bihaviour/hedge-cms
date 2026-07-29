import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { HedgeAsset, HedgeBinding } from '../packages/core/src/system'

/**
 * The pure pieces of the release-artifact build (#32), split out from the CLI so they can be tested
 * without a filesystem — and so the one algorithm that must match Cloudflare exactly, the asset
 * hash, is pinned by a test.
 */

/**
 * wrangler's asset hash: `sha256(base64(contents) + extension).slice(0, 32)`, hex.
 *
 * This is **not** a plain content hash. The assets-upload-session manifest is keyed on this exact
 * value, so Cloudflare compares like-for-like and re-uploads only what changed. Compute it any other
 * way — even a correct SHA-256 of the raw bytes — and every asset re-uploads on every update,
 * silently, because no manifest key ever matches what the deployment already has. The extension is
 * taken without its dot and *not* lowercased, matching `extname().substring(1)` in wrangler.
 */
export function assetHash(contents: Uint8Array, path: string): string {
  const base64 = Buffer.from(contents).toString('base64')
  const extension = extname(path).substring(1)
  return createHash('sha256')
    .update(base64 + extension)
    .digest('hex')
    .slice(0, 32)
}

/** The `Content-Type` Cloudflare should serve an asset as — it uses whatever is supplied at upload. */
export function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

/** One asset's manifest entry, from its served path and bytes. */
export function assetEntry(servedPath: string, contents: Uint8Array): HedgeAsset {
  return {
    path: servedPath,
    size: contents.length,
    hash: assetHash(contents, servedPath),
    contentType: contentTypeFor(servedPath),
  }
}

/**
 * The binding *declarations* for the manifest — types and names, and a var's text, but **never** an
 * id. `DB` and `MEDIA` carry account-specific ids that must not travel in an artifact built from a
 * tag; the updater merges these over the ids it reads from the running deployment.
 */
export function bindingDeclarations(wrangler: {
  d1_databases?: Array<{ binding: string }>
  r2_buckets?: Array<{ binding: string }>
  send_email?: Array<{ name: string }>
  assets?: { binding?: string }
  vars?: Record<string, string>
}): HedgeBinding[] {
  const bindings: HedgeBinding[] = []
  for (const db of wrangler.d1_databases ?? []) bindings.push({ type: 'd1', name: db.binding })
  for (const bucket of wrangler.r2_buckets ?? []) {
    bindings.push({ type: 'r2_bucket', name: bucket.binding })
  }
  for (const email of wrangler.send_email ?? [])
    bindings.push({ type: 'send_email', name: email.name })
  if (wrangler.assets?.binding) bindings.push({ type: 'assets', name: wrangler.assets.binding })
  for (const [name, text] of Object.entries(wrangler.vars ?? {})) {
    bindings.push({ type: 'plain_text', name, text })
  }
  return bindings
}

/** Strip `//` and `/* *​/` comments and trailing commas from JSONC, respecting string literals. */
export function parseJsonc(source: string): unknown {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '"') {
      out += c
      i++
      while (i < n) {
        out += source[i]
        if (source[i] === '\\') {
          out += source[i + 1] ?? ''
          i += 2
          continue
        }
        if (source[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '/' && next === '/') {
      i += 2
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  // Drop trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(out)
}

/** One file destined for the tarball. */
export interface TarEntry {
  name: string
  data: Uint8Array
}

/**
 * A minimal, reproducible ustar writer. No mtime, uid or gid, and entries are emitted in the order
 * given (the CLI sorts them), so the same inputs always produce the same bytes — the artifact has to
 * be reproducible from the tag alone.
 */
export function createTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const entry of entries) {
    const header = new Uint8Array(512)
    writeString(header, entry.name, 0, 100)
    writeOctal(header, 0o644, 100, 8) // mode
    writeOctal(header, 0, 108, 8) // uid
    writeOctal(header, 0, 116, 8) // gid
    writeOctal(header, entry.data.length, 124, 12) // size
    writeOctal(header, 0, 136, 12) // mtime — zero, for reproducibility
    header[156] = 0x30 // typeflag '0' (regular file)
    writeString(header, 'ustar\0', 257, 6) // magic
    writeString(header, '00', 263, 2) // version

    // Checksum is computed with the checksum field itself read as spaces.
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let sum = 0
    for (const byte of header) sum += byte
    writeString(header, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)

    blocks.push(header)
    blocks.push(entry.data)
    const remainder = entry.data.length % 512
    if (remainder !== 0) blocks.push(new Uint8Array(512 - remainder))
  }

  // Two zero blocks end the archive.
  blocks.push(new Uint8Array(1024))

  const total = blocks.reduce((acc, block) => acc + block.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

function writeString(buffer: Uint8Array, value: string, offset: number, length: number): void {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length > length)
    throw new Error(`tar field overflow: "${value}" exceeds ${length} bytes`)
  buffer.set(bytes, offset)
}

function writeOctal(buffer: Uint8Array, value: number, offset: number, length: number): void {
  // `length - 1` octal digits, null-terminated — the classic ustar numeric field.
  writeString(buffer, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length)
}
