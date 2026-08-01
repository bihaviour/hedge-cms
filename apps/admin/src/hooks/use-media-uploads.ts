import type { Media } from '@hedge/core'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { createUploadQueue, type UploadQueue, type UploadTask } from '@/lib/uploads'

/**
 * React's view of an upload queue: the list to render, and the four things a person can do to it.
 * The queue itself is `lib/uploads.ts` — this only binds it to a component's lifetime.
 */
export interface MediaUploads extends Omit<UploadQueue, 'tasks'> {
  tasks: UploadTask[]
  /** True while anything is queued or in flight. */
  busy: boolean
}

export function useMediaUploads({
  accept = [],
  onUploaded,
  onSettled,
}: {
  /** The field's `accept` list, empty for the library. Checked before a byte is sent. */
  accept?: string[]
  /** Called once per file as it lands, in completion order. */
  onUploaded?: (media: Media) => void
  /** Called when the queue drains, with what the batch as a whole did. */
  onSettled?: (result: { uploaded: number; failed: number }) => void
} = {}): MediaUploads {
  const [tasks, setTasks] = useState<UploadTask[]>([])

  // The queue outlives the render that built it, so everything it calls back into is read through
  // a ref at the moment it is needed rather than captured when it was created — otherwise an
  // upload finishing two renders later would report to a stale closure.
  const latest = useRef({ accept, onUploaded, onSettled })
  latest.current = { accept, onUploaded, onSettled }

  // An upload that finishes after the dialog holding this hook has closed must not set state.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const queue = useRef<UploadQueue>(null)
  if (!queue.current) {
    queue.current = createUploadQueue({
      upload: (file, onProgress) => api.media.upload(file, undefined, onProgress),
      onChange: (next) => {
        if (mounted.current) setTasks(next)
      },
      accept: () => latest.current.accept,
      onUploaded: (media) => latest.current.onUploaded?.(media),
      onSettled: (result) => latest.current.onSettled?.(result),
    })
  }

  const busy = tasks.some((task) => task.state === 'queued' || task.state === 'uploading')

  return {
    tasks,
    busy,
    add: queue.current.add,
    retry: queue.current.retry,
    dismiss: queue.current.dismiss,
    clear: queue.current.clear,
  }
}
