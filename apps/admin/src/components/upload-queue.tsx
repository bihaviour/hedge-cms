import { MAX_UPLOAD_BYTES } from '@hedge/core'
import { AlertCircle, Check, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MediaUploads } from '@/hooks/use-media-uploads'
import { useT } from '@/lib/i18n'
import type { UploadTask } from '@/lib/uploads'
import { cn, formatBytes } from '@/lib/utils'

/**
 * What a batch of uploads looks like while it is happening: one row per file, its own progress,
 * its own outcome. The alternative — a single spinner over the whole selection — cannot say which
 * of ten files failed, and "some of them uploaded" is the normal case when a folder is dropped.
 */
export function UploadQueue({ uploads, className }: { uploads: MediaUploads; className?: string }) {
  const t = useT()
  if (uploads.tasks.length === 0) return null

  const total = uploads.tasks.length
  const settled = uploads.tasks.filter(
    (task) => task.state === 'done' || task.state === 'error',
  ).length
  const uploaded = uploads.tasks.filter((task) => task.state === 'done').length

  return (
    <div className={cn('space-y-2 rounded-lg border p-3', className)}>
      <div className="flex items-center justify-between gap-2">
        {/* Counting settled files while it runs and successful ones once it has stopped: mid-flight
            the question is how much is left, and afterwards it is what actually landed. */}
        <p className="font-medium text-sm">
          {uploads.busy
            ? t('upload.progressTitle', { done: settled, total })
            : t('upload.finishedTitle', { done: uploaded, total })}
        </p>
        {settled > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={uploads.clear}>
            {t('upload.clearFinished')}
          </Button>
        )}
      </div>

      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {uploads.tasks.map((task) => (
          <li key={task.id}>
            <UploadRow task={task} uploads={uploads} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function UploadRow({ task, uploads }: { task: UploadTask; uploads: MediaUploads }) {
  const t = useT()
  const percent = Math.round(task.progress * 100)

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm" title={task.file.name}>
            {task.file.name}
          </p>
          <span className="shrink-0 text-muted-foreground text-xs">
            {formatBytes(task.file.size)}
          </span>
        </div>

        {task.state === 'error' ? (
          <p className="flex items-center gap-1.5 text-destructive text-xs">
            <AlertCircle className="size-3.5 shrink-0" />
            <span className="truncate" title={failureText(t, task)}>
              {failureText(t, task)}
            </span>
          </p>
        ) : (
          // A determinate bar, because the client knows the byte count — `api.media.upload` reports
          // real request progress rather than a spinner standing in for it.
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={t('upload.progressAria', { filename: task.file.name })}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                'h-full rounded-full transition-all',
                task.state === 'done' ? 'bg-primary/60' : 'bg-primary',
              )}
              style={{ width: `${task.state === 'queued' ? 0 : percent}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {task.state === 'done' && <Check className="size-4 text-muted-foreground" />}
        {/* Only a failure that could go differently offers a retry: a file over the size cap or of
            a type the deployment refuses is the same file however many times it is sent. */}
        {task.state === 'error' && !task.rejection && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('upload.retryAria', { filename: task.file.name })}
            onClick={() => uploads.retry(task.id)}
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
        {(task.state === 'done' || task.state === 'error') && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('upload.dismissAria', { filename: task.file.name })}
            onClick={() => uploads.dismiss(task.id)}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** The API's own message when there is one, and a translated sentence when the browser decided. */
function failureText(t: ReturnType<typeof useT>, task: UploadTask): string {
  switch (task.rejection) {
    case 'too-large':
      return t('upload.tooLarge', { size: formatBytes(MAX_UPLOAD_BYTES) })
    case 'unsupported-type':
      return t('upload.unsupportedType')
    case 'not-accepted':
      return t('upload.notAccepted')
    default:
      return task.message ?? t('common.error')
  }
}
