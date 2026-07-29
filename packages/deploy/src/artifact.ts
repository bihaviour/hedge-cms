import { type HedgeManifest, hedgeManifestSchema } from '@hedge/core'

/**
 * Reads a release artifact — `hedge-<version>.tar.gz`: verify its checksum, expand it with
 * `DecompressionStream('gzip')` and a tar reader, and expose the files by path plus the parsed
 * `hedge.json`. This is the input the deploy client (`./cloudflare/`) works from, for the updater
 * moving a deployment forward and for the installer creating one.
 *
 * Memory is the real constraint, set by the tighter of the two callers: the Worker has 128 MB, and a
 * careless read holds the artifact compressed *and* expanded. So the compressed bytes are dropped as
 * soon as they are decompressed, and the tar reader slices the single expanded buffer rather than
 * copying each file out.
 */

/** The three kinds of thing the artifact carries, over the flat file map the tar reader produces. */
export interface Artifact {
  manifest: HedgeManifest
  /** Every file in the tarball, keyed by its path within it (`index.js`, `admin/index.html`, …). */
  files: Map<string, Uint8Array>
  /** The Worker's own modules — everything that is neither an admin asset nor a migration. */
  workerModules(): Array<{ name: string; content: Uint8Array }>
  /** The bytes for a served asset path (`/index.html`), which live under `admin/` in the tarball. */
  assetBytes(servedPath: string): Uint8Array | undefined
  /** Migration files, in filename order — what the runner applies. */
  migrations(): Array<{ name: string; sql: string }>
}

const ADMIN_PREFIX = 'admin/'
const MIGRATIONS_PREFIX = 'migrations/'
const MANIFEST_NAME = 'hedge.json'

/** Fetch the tarball and its expected checksum, then read it. */
export async function fetchArtifact(tarballUrl: string, expectedSha256: string): Promise<Artifact> {
  const response = await fetch(tarballUrl)
  if (!response.ok) {
    throw new Error(`could not download the release artifact (HTTP ${response.status})`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return readArtifact(bytes, expectedSha256)
}

/** Verify, decompress and parse an artifact already in memory. */
export async function readArtifact(gzBytes: Uint8Array, expectedSha256: string): Promise<Artifact> {
  const actual = await sha256Hex(gzBytes)
  if (actual !== expectedSha256.trim().toLowerCase()) {
    throw new Error(
      `release artifact checksum mismatch — expected ${expectedSha256.trim()}, got ${actual}`,
    )
  }

  const expanded = await gunzip(gzBytes)
  const files = untar(expanded)

  const manifestBytes = files.get(MANIFEST_NAME)
  if (!manifestBytes) throw new Error(`artifact is missing ${MANIFEST_NAME}`)
  const manifest = hedgeManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)))

  return {
    manifest,
    files,
    workerModules() {
      const modules: Array<{ name: string; content: Uint8Array }> = []
      for (const [name, content] of files) {
        if (name === MANIFEST_NAME) continue
        if (name.startsWith(ADMIN_PREFIX) || name.startsWith(MIGRATIONS_PREFIX)) continue
        modules.push({ name, content })
      }
      return modules
    },
    assetBytes(servedPath) {
      // Manifest paths are the served path with a leading slash (`/index.html`); assets are stored
      // under `admin/` in the tarball, so `/index.html` → `admin/index.html`.
      const relative = servedPath.startsWith('/') ? servedPath.slice(1) : servedPath
      return files.get(ADMIN_PREFIX + relative)
    },
    migrations() {
      const decoder = new TextDecoder()
      return [...files.entries()]
        .filter(([name]) => name.startsWith(MIGRATIONS_PREFIX) && name.endsWith('.sql'))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, content]) => ({
          name: name.slice(MIGRATIONS_PREFIX.length),
          sql: decoder.decode(content),
        }))
    },
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function gunzip(gzBytes: Uint8Array): Promise<Uint8Array> {
  // The assertion is a types-only concession to this package having two homes: lib.dom narrows a
  // blob part to `ArrayBufferView<ArrayBuffer>`, which a `Uint8Array` generic over `ArrayBufferLike`
  // does not satisfy, while workerd's own types accept it. Both accept the value at run time.
  const stream = new Blob([gzBytes as ArrayBufferView<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * A minimal POSIX/ustar tar reader — enough for an archive this code also produces. Handles the
 * `ustar` prefix field, GNU long names (`L`) and pax `path=` overrides, so a future deeper asset
 * tree doesn't silently truncate a name at 100 characters.
 */
function untar(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  let offset = 0
  let longName: string | null = null

  const readString = (start: number, length: number): string => {
    const slice = data.subarray(start, start + length)
    const end = slice.indexOf(0)
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end))
  }

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    // Two consecutive zero blocks mark the end; a single all-zero block is enough to stop.
    if (header.every((byte) => byte === 0)) break

    const sizeField = readString(offset + 124, 12).trim()
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0
    const typeflag = String.fromCharCode(data[offset + 156] ?? 0)
    const dataStart = offset + 512
    const blocks = Math.ceil(size / 512)

    if (typeflag === 'L') {
      // GNU long name: this block's data is the name of the *next* entry.
      longName = readString(dataStart, size).replace(/\0+$/, '')
    } else if (typeflag === 'x' || typeflag === 'g') {
      // pax extended header: pull a `path=` record out if present.
      const record = decoder.decode(data.subarray(dataStart, dataStart + size))
      const match = /\d+ path=([^\n]+)\n/.exec(record)
      if (match) longName = match[1] ?? null
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const prefix = readString(offset + 345, 155)
      const name = readString(offset, 100)
      const fullName = longName ?? (prefix ? `${prefix}/${name}` : name)
      files.set(fullName, data.slice(dataStart, dataStart + size))
      longName = null
    } else {
      // Directory ('5') or anything else: no bytes we need. Clear any pending long name.
      longName = null
    }

    offset = dataStart + blocks * 512
  }

  return files
}
