import { isAllowedUploadType, MAX_UPLOAD_BYTES, type Media, matchesAccept } from '@hedge/core'

/**
 * Uploading several files at once, with no React in it.
 *
 * Uploading used to be one file per click: the media library's file input read `files[0]` and
 * dropped the rest, and the picker looped one mutation over a selection behind a single shared
 * spinner — so ten files produced ten toasts, no per-file progress, and no way to tell which one
 * was still going or which had failed. What replaces it is a queue, and the queue lives here
 * rather than inside the hook so the part with the actual behaviour — bounded concurrency, retry,
 * what a batch reports when it drains — can be tested without a DOM, and so the library and the
 * picker cannot answer any of it differently.
 */

/**
 * Why a file will not be sent. A code rather than a sentence, because the message is translated
 * where it is rendered and this module has no catalog.
 */
export type UploadRejection =
  /** Over `MAX_UPLOAD_BYTES` — the server would answer 413 after receiving the whole thing. */
  | 'too-large'
  /** Not in `ALLOWED_UPLOAD_TYPES` — the server would answer 415. */
  | 'unsupported-type'
  /** Allowed by the deployment, but not by the `accept` list of the field being filled. */
  | 'not-accepted'

/**
 * The verdict on one file, before a byte leaves the browser. **The server is still the authority**
 * — `routes/media.ts` re-checks size and type on every upload — but it is handed the same two
 * inputs this is, so the two agree by construction, and checking here turns a 25 MB round trip
 * ending in a 413 into an instant answer. Which matters more when ten files were dropped at once:
 * one bad file should not spend the queue's capacity on the way to being refused.
 *
 * `accept` is the field's list, and is empty for the media library — which takes anything the
 * deployment does.
 */
export function uploadRejection(
  file: { name: string; type: string; size: number },
  accept: string[] = [],
): UploadRejection | null {
  if (file.size > MAX_UPLOAD_BYTES) return 'too-large'
  // The same fallback the route applies, so a file the browser has no type for is judged
  // identically on both sides rather than being waved through here and refused there.
  const contentType = file.type || 'application/octet-stream'
  if (!isAllowedUploadType(contentType)) return 'unsupported-type'
  if (!matchesAccept(contentType, accept, file.name)) return 'not-accepted'
  return null
}

/**
 * How many uploads are in flight at once.
 *
 * Not unbounded: dropping thirty files would open thirty requests, a browser queues all but six
 * per origin anyway, and the only thing that buys is thirty progress bars sitting at zero. Three
 * keeps the connection busy, leaves room for the thumbnails and the listing refetch the same page
 * is making, and keeps a failure to a small batch.
 */
export const UPLOAD_CONCURRENCY = 3

export type UploadState = 'queued' | 'uploading' | 'done' | 'error'

export interface UploadTask {
  /** Stable across a retry, so a row does not move in the list. */
  id: string
  file: File
  state: UploadState
  /** 0–1. Meaningful while `uploading`, 1 once done. */
  progress: number
  /** Set when the file was refused before being sent. Not retryable — see `retry`. */
  rejection?: UploadRejection
  /** The API's message, when the upload itself failed. */
  message?: string
  media?: Media
}

export interface UploadQueue {
  /** The current list, newest last. A fresh array on every change. */
  tasks: () => UploadTask[]
  /** Queues files. Nothing is silently skipped: a file that cannot be sent is added already failed. */
  add: (files: FileList | File[] | null | undefined) => void
  retry: (id: string) => void
  dismiss: (id: string) => void
  /** Forgets everything that has settled, leaving what is still running. */
  clear: () => void
}

export interface UploadQueueOptions {
  /** Sends one file. Injected so the queue has no opinion about the transport. */
  upload: (file: File, onProgress: (fraction: number) => void) => Promise<Media>
  /** Called on every change, with the whole list — the caller renders from it. */
  onChange: (tasks: UploadTask[]) => void
  /** Read when a file is queued, not when the queue was built: a field's list can change. */
  accept?: () => string[]
  /** Called once per file as it lands, in completion order. */
  onUploaded?: (media: Media) => void
  /** Called when the queue drains, with what the batch as a whole did. */
  onSettled?: (result: { uploaded: number; failed: number }) => void
  concurrency?: number
}

let counter = 0
const nextTaskId = () => `upl_${++counter}`

export function createUploadQueue(options: UploadQueueOptions): UploadQueue {
  const concurrency = options.concurrency ?? UPLOAD_CONCURRENCY

  let tasks: UploadTask[] = []
  let waiting: UploadTask[] = []
  let active = 0
  // Counted across the whole batch rather than per call to `add`, so files dropped while an
  // earlier drop is still uploading are reported once, when everything has stopped.
  let batch = { uploaded: 0, failed: 0 }

  function commit(next: UploadTask[]) {
    tasks = next
    options.onChange(tasks)
  }

  function patch(id: string, changes: Partial<UploadTask>) {
    commit(tasks.map((task) => (task.id === id ? { ...task, ...changes } : task)))
  }

  async function run(task: UploadTask) {
    patch(task.id, { state: 'uploading', progress: 0 })
    try {
      const media = await options.upload(task.file, (fraction) => {
        // Rounded to whole percent: a 25 MB body fires far more progress events than the bar has
        // pixels, and every one of them would otherwise be a render.
        patch(task.id, { progress: Math.round(fraction * 100) / 100 })
      })
      batch.uploaded += 1
      patch(task.id, { state: 'done', progress: 1, media })
      options.onUploaded?.(media)
    } catch (error) {
      batch.failed += 1
      patch(task.id, { state: 'error', message: messageFor(error) })
    } finally {
      active -= 1
      pump()
      if (active === 0 && waiting.length === 0) settle()
    }
  }

  function pump() {
    while (active < concurrency && waiting.length > 0) {
      const task = waiting.shift()!
      active += 1
      void run(task)
    }
  }

  function settle() {
    const result = batch
    batch = { uploaded: 0, failed: 0 }
    if (result.uploaded || result.failed) options.onSettled?.(result)
  }

  return {
    tasks: () => tasks,

    add(files) {
      const incoming = Array.from(files ?? [])
      if (incoming.length === 0) return
      const accept = options.accept?.() ?? []

      const created: UploadTask[] = incoming.map((file) => {
        const rejection = uploadRejection(file, accept)
        return {
          id: nextTaskId(),
          file,
          state: rejection ? ('error' as const) : ('queued' as const),
          progress: 0,
          ...(rejection ? { rejection } : {}),
        }
      })
      commit([...tasks, ...created])

      const sendable = created.filter((task) => task.state === 'queued')
      // A file refused here counts against the batch exactly as a failed request does. Leaving it
      // out would report five files dropped and one refused as "uploaded 4", success — and a
      // caller that clears the panel on a clean batch would then sweep away the row saying why
      // the fifth is missing.
      batch.failed += created.length - sendable.length

      // A batch refused in full never enters the queue, so it reports itself rather than waiting
      // for a drain that will never happen.
      if (sendable.length === 0) {
        settle()
        return
      }
      waiting.push(...sendable)
      pump()
    },

    retry(id) {
      const task = tasks.find((candidate) => candidate.id === id)
      // A file refused before it was sent is not retryable: nothing about it has changed, so the
      // answer would not either.
      if (task?.state !== 'error' || task.rejection) return
      const reset: UploadTask = { ...task, state: 'queued', progress: 0, message: undefined }
      commit(tasks.map((candidate) => (candidate.id === id ? reset : candidate)))
      waiting.push(reset)
      pump()
    },

    dismiss(id) {
      waiting = waiting.filter((task) => task.id !== id)
      commit(tasks.filter((task) => task.id !== id))
    },

    clear() {
      commit(tasks.filter((task) => task.state === 'queued' || task.state === 'uploading'))
    },
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
