import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_UPLOAD_BYTES } from '@hedge/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { media, sites } from '../db/schema'
import type { Bindings } from '../env'

/**
 * `storeUpload`, against a real SQLite built from the committed migrations and a stand-in R2.
 *
 * It is the one place either upload path writes an object, so what is pinned here is the part
 * neither caller can check for itself: the size is counted from the bytes that actually arrived, not
 * taken from a header or a `File.size`, and a body that outgrows the cap is refused before a key is
 * ever named. A fetched URL has no trustworthy length, which is what makes that the difference
 * between a cap and a suggestion — and what forces the body into memory, since R2 will not take a
 * stream whose length it cannot know.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

const { storeUpload } = await import('./media')

/** The `ApiError.code` a rejection carried, or `null` if it resolved or threw something else. */
async function refusalCode(work: Promise<unknown>): Promise<string | null> {
  try {
    await work
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? null
  }
}

const MIGRATIONS = join(import.meta.dir, '../../migrations')

function migrate(sqlite: Database) {
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
}

const site = { id: 'site_1', slug: 'blog' }

/**
 * Records what reached the bucket, and refuses what R2 itself refuses.
 *
 * The type check is the whole value of this stand-in, not decoration. R2's `put` takes bytes, a
 * blob, or a stream *whose length it can know* — a request/response body, or the readable half of a
 * `FixedLengthStream` — and throws `TypeError: Provided readable stream must have a known length`
 * for anything else, a body piped through a `TransformStream` included. A fake that cheerfully
 * drained whatever it was handed is exactly what let a metered upload ship green and then fail on
 * every real request, with the reason swallowed into a 500. So this one throws what R2 throws.
 */
function bucket() {
  const objects = new Map<string, number>()
  const deleted: string[] = []

  return {
    objects,
    deleted,
    binding: {
      put: async (key: string, body: unknown) => {
        if (!(body instanceof Uint8Array)) {
          throw new TypeError(
            'Provided readable stream must have a known length ' +
              '(request/response body or readable half of FixedLengthStream)',
          )
        }
        objects.set(key, body.byteLength)
      },
      delete: async (key: string) => {
        objects.delete(key)
        deleted.push(key)
      },
    },
  }
}

/** A body delivered in several chunks, so the meter is exercised across chunk boundaries. */
function chunked(total: number, chunk = 8 * 1024): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close()
      const size = Math.min(chunk, total - sent)
      sent += size
      controller.enqueue(new Uint8Array(size))
    },
  })
}

/** A 1×1 PNG, so the dimension read has something real to find in the head. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
)

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

let store: ReturnType<typeof bucket>
let env: Bindings

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite)

  await db.insert(sites).values({
    id: site.id,
    slug: site.slug,
    name: 'Blog',
    locales: ['en'],
    defaultLocale: 'en',
    timezone: 'UTC',
  })

  store = bucket()
  env = { MEDIA: store.binding, PUBLIC_URL: 'https://cms.example.com' } as unknown as Bindings
})

describe('storeUpload', () => {
  test('streams the file into R2 and records what it actually weighed', async () => {
    const result = await storeUpload(env, site, {
      body: stream(PNG),
      filename: 'Photo One.png',
      contentType: 'image/png',
      alt: 'A photo',
      uploadedBy: 'usr_1',
    })

    expect(result.size).toBe(PNG.byteLength)
    expect(result.width).toBe(1)
    expect(result.height).toBe(1)
    expect(result.alt).toBe('A photo')
    expect(result.url).toBe(`https://cms.example.com/media/${result.key}`)
    // Site- and date-prefixed, and the spaces and case in the filename are gone from the key.
    expect(result.key).toStartWith('blog/')
    expect(result.key).toEndWith('-photo-one.png')
    expect(store.objects.get(result.key)).toBe(PNG.byteLength)

    const [row] = await db.select().from(media)
    expect(row?.id).toBe(result.id)
  })

  test('counts across chunk boundaries rather than trusting a declared length', async () => {
    const result = await storeUpload(env, site, {
      body: chunked(100_000),
      filename: 'clip.mp4',
      contentType: 'video/mp4',
    })

    expect(result.size).toBe(100_000)
    expect(store.objects.get(result.key)).toBe(100_000)
  })

  test('refuses a disallowed content type without touching the bucket', async () => {
    const code = await refusalCode(
      storeUpload(env, site, {
        body: stream(PNG),
        filename: 'run.sh',
        contentType: 'application/x-sh',
      }),
    )

    expect(code).toBe('unsupported_media_type')
    expect(store.objects.size).toBe(0)
    expect(await db.select().from(media)).toHaveLength(0)
  })

  test('takes the bare type when the caller sent parameters with it', async () => {
    const result = await storeUpload(env, site, {
      body: stream(PNG),
      filename: 'a.png',
      contentType: 'image/png; charset=binary',
    })
    expect(result.contentType).toBe('image/png')
  })

  test('a body that outgrows the cap mid-stream leaves no row and no object', async () => {
    const code = await refusalCode(
      storeUpload(env, site, {
        body: chunked(MAX_UPLOAD_BYTES + 64 * 1024),
        filename: 'huge.mp4',
        contentType: 'video/mp4',
      }),
    )

    expect(code).toBe('payload_too_large')
    expect(await db.select().from(media)).toHaveLength(0)
    expect(store.objects.size).toBe(0)
    // Refused while reading, before a key existed — so there is no partial object to sweep either.
    expect(store.deleted).toHaveLength(0)
  })

  test('hands R2 a body it will accept, not a metered stream', async () => {
    // The regression this file exists to stop. Counting bytes means transforming the body, and a
    // transformed body is precisely the one shape R2 rejects — so the count has to come off bytes
    // already read rather than off a pipe into the bucket. Chunked, because the fetched-URL path
    // arrives that way and is where a declared length is least trustworthy.
    const captured: unknown[] = []
    const put = store.binding.put
    store.binding.put = async (key: string, body: unknown) => {
      captured.push(body)
      return put(key, body)
    }

    const result = await storeUpload(env, site, {
      body: chunked(40_000),
      filename: 'clip.mp4',
      contentType: 'video/mp4',
    })

    expect(captured[0]).toBeInstanceOf(Uint8Array)
    expect((captured[0] as Uint8Array).byteLength).toBe(40_000)
    expect(result.size).toBe(40_000)
  })
})
