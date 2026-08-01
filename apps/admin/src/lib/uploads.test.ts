import { describe, expect, test } from 'bun:test'
import { MAX_UPLOAD_BYTES, type Media } from '@hedge/core'
import { createUploadQueue, type UploadTask, uploadRejection } from './uploads'

/**
 * A `File` stand-in. `uploadRejection` reads three properties and the queue only carries the file
 * to the injected uploader, so nothing here needs a DOM.
 */
const file = (name: string, type = 'image/png', size = 1024) =>
  ({ name, type, size }) as unknown as File

const mediaFor = (name: string): Media => ({
  id: `med_${name}`,
  key: `site/2026/08/${name}`,
  filename: name,
  contentType: 'image/png',
  size: 1024,
  width: null,
  height: null,
  alt: null,
  url: `/media/site/2026/08/${name}`,
  createdAt: '2026-08-01T00:00:00.000Z',
})

describe('uploadRejection', () => {
  test('accepts a supported file inside the size cap', () => {
    expect(uploadRejection(file('photo.jpg', 'image/jpeg'))).toBeNull()
  })

  test('refuses a file over the cap before it is sent', () => {
    expect(uploadRejection(file('huge.png', 'image/png', MAX_UPLOAD_BYTES + 1))).toBe('too-large')
  })

  test('refuses a type the deployment does not allow', () => {
    expect(uploadRejection(file('app.exe', 'application/x-msdownload'))).toBe('unsupported-type')
  })

  /**
   * The route applies the same fallback, so a file the browser could not type is judged the same
   * on both sides — waving it through here would mean uploading it in full to be told 415.
   */
  test('treats a file with no type the way the route does', () => {
    expect(uploadRejection(file('notes', ''))).toBe('unsupported-type')
  })

  test("honours the field's accept list, which is narrower than the deployment's", () => {
    expect(uploadRejection(file('doc.pdf', 'application/pdf'), ['image/*'])).toBe('not-accepted')
    expect(uploadRejection(file('photo.png', 'image/png'), ['image/*'])).toBeNull()
  })

  test('an empty accept list accepts anything the deployment does', () => {
    expect(uploadRejection(file('doc.pdf', 'application/pdf'), [])).toBeNull()
  })
})

/** A queue whose uploader is under the test's control, so ordering is observable. */
function harness(
  options: { accept?: string[]; concurrency?: number; fails?: (name: string) => boolean } = {},
) {
  let latest: UploadTask[] = []
  const settled: { uploaded: number; failed: number }[] = []
  const uploaded: Media[] = []
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  let peak = 0
  let active = 0

  const queue = createUploadQueue({
    concurrency: options.concurrency,
    accept: () => options.accept ?? [],
    onChange: (tasks) => {
      latest = tasks
    },
    onUploaded: (media) => uploaded.push(media),
    onSettled: (result) => settled.push(result),
    upload: (file) => {
      active += 1
      peak = Math.max(peak, active)
      return new Promise<Media>((resolve, reject) => {
        pending.set(file.name, {
          resolve: () => {
            active -= 1
            resolve(mediaFor(file.name))
          },
          reject: (error) => {
            active -= 1
            reject(error)
          },
        })
      })
    },
  })

  return {
    queue,
    uploaded,
    settled,
    tasks: () => latest,
    inFlight: () => [...pending.keys()],
    peak: () => peak,
    /** Finishes one upload and lets the queue's own `finally` run before the test looks again. */
    async finish(name: string, error?: Error) {
      const handle = pending.get(name)
      if (!handle) throw new Error(`${name} is not in flight`)
      pending.delete(name)
      if (error) handle.reject(error)
      else handle.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

describe('the upload queue', () => {
  test('runs up to the concurrency limit and starts the next file as one finishes', async () => {
    const h = harness({ concurrency: 2 })
    h.queue.add([file('a.png'), file('b.png'), file('c.png')])

    expect(h.inFlight().sort()).toEqual(['a.png', 'b.png'])
    expect(h.tasks().map((task) => task.state)).toEqual(['uploading', 'uploading', 'queued'])

    await h.finish('a.png')
    expect(h.inFlight().sort()).toEqual(['b.png', 'c.png'])
    expect(h.peak()).toBe(2)
  })

  test('reports the batch once, when everything has stopped', async () => {
    const h = harness({ concurrency: 2 })
    h.queue.add([file('a.png'), file('b.png'), file('c.png')])

    await h.finish('a.png')
    await h.finish('b.png')
    expect(h.settled).toEqual([])

    await h.finish('c.png')
    expect(h.settled).toEqual([{ uploaded: 3, failed: 0 }])
    expect(h.uploaded.map((media) => media.filename)).toEqual(['a.png', 'b.png', 'c.png'])
  })

  /** One failure must not take the rest of the batch with it — the whole point of per-file state. */
  test('a failed file leaves the others alone and is reported alongside them', async () => {
    const h = harness({ concurrency: 3 })
    h.queue.add([file('a.png'), file('b.png')])

    await h.finish('a.png', new Error('Files must be under 26214400 bytes'))
    await h.finish('b.png')

    expect(h.settled).toEqual([{ uploaded: 1, failed: 1 }])
    const [first, second] = h.tasks()
    expect(first?.state).toBe('error')
    expect(first?.message).toBe('Files must be under 26214400 bytes')
    expect(second?.state).toBe('done')
    expect(second?.media?.filename).toBe('b.png')
  })

  test('retrying a failed upload sends it again and keeps its row', async () => {
    const h = harness()
    h.queue.add([file('a.png')])
    await h.finish('a.png', new Error('Upload failed'))

    const [failed] = h.tasks()
    h.queue.retry(failed!.id)
    expect(h.inFlight()).toEqual(['a.png'])
    expect(h.tasks()).toHaveLength(1)
    expect(h.tasks()[0]?.id).toBe(failed!.id)

    await h.finish('a.png')
    expect(h.tasks()[0]?.state).toBe('done')
  })

  test('a file refused before it was sent never reaches the uploader, and cannot be retried', () => {
    const h = harness({ accept: ['image/*'] })
    h.queue.add([file('notes.pdf', 'application/pdf'), file('huge.png', 'image/png', 1e9)])

    expect(h.inFlight()).toEqual([])
    expect(h.tasks().map((task) => task.rejection)).toEqual(['not-accepted', 'too-large'])
    // Nothing entered the queue, so the batch reports itself rather than waiting for a drain.
    expect(h.settled).toEqual([{ uploaded: 0, failed: 2 }])

    h.queue.retry(h.tasks()[0]!.id)
    expect(h.inFlight()).toEqual([])
  })

  /**
   * The failure this pins was live: a rejected file was left out of the tally, so five files with
   * one refused reported "uploaded 4, failed 0" — a clean batch — and the caller that clears the
   * panel on a clean batch swept away the one row explaining where the fifth went.
   */
  test('a file refused before it was sent counts against the batch it arrived with', async () => {
    const h = harness({ concurrency: 3 })
    h.queue.add([file('a.png'), file('b.png'), file('nope.exe', 'application/x-msdownload')])

    expect(h.inFlight().sort()).toEqual(['a.png', 'b.png'])
    await h.finish('a.png')
    await h.finish('b.png')
    expect(h.settled).toEqual([{ uploaded: 2, failed: 1 }])
  })

  test('clearing keeps what is still running', async () => {
    const h = harness({ concurrency: 1 })
    h.queue.add([file('a.png'), file('b.png')])
    await h.finish('a.png')

    h.queue.clear()
    expect(h.tasks().map((task) => task.file.name)).toEqual(['b.png'])
  })

  test('dismissing a queued file un-queues it', async () => {
    const h = harness({ concurrency: 1 })
    h.queue.add([file('a.png'), file('b.png')])

    h.queue.dismiss(h.tasks()[1]!.id)
    await h.finish('a.png')

    expect(h.inFlight()).toEqual([])
    expect(h.tasks().map((task) => task.file.name)).toEqual(['a.png'])
  })

  test('files dropped while a batch is running join it rather than starting a second report', async () => {
    const h = harness({ concurrency: 3 })
    h.queue.add([file('a.png')])
    h.queue.add([file('b.png')])

    await h.finish('a.png')
    expect(h.settled).toEqual([])
    await h.finish('b.png')
    expect(h.settled).toEqual([{ uploaded: 2, failed: 0 }])
  })
})
