import type { EntryRevision } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { diffFields, previewValue } from '@/lib/field-diff'
import { useFormatters, useT } from '@/lib/i18n'

/**
 * A revision is written before every edit; this lists them and restores one. Restoring is itself an
 * edit (the server snapshots the current state first), so it is undoable — which is why the button
 * doesn't warn: there is nothing to lose that isn't kept.
 *
 * Its counterpart above it in the editor's sidebar is `EntryVersions`: what this entry *was*, and
 * what it *may become*.
 */
export function EntryRevisions({
  collection,
  slug,
  locale,
  currentData,
}: {
  collection: string
  slug: string
  locale: string
  currentData: Record<string, unknown>
}) {
  const t = useT()
  const siteSlug = useActiveSiteSlug()
  const { formatDateTime } = useFormatters()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<EntryRevision | null>(null)

  const revisions = useQuery({
    queryKey: ['revisions', siteSlug, collection, slug, locale],
    queryFn: () => api.entries.revisions(collection, slug, locale),
    enabled: Boolean(siteSlug),
  })

  const restore = useMutation({
    mutationFn: (id: string) => api.entries.restore(collection, slug, id, locale),
    onSuccess: () => {
      // The editor reseeds its form from the entry query, so refetching it is what makes the
      // restored values appear without a manual reload.
      queryClient.invalidateQueries({ queryKey: ['entry', siteSlug, collection, slug] })
      queryClient.invalidateQueries({ queryKey: ['entries', collection] })
      queryClient.invalidateQueries({ queryKey: ['revisions', siteSlug, collection, slug] })
      setSelected(null)
      toast.success(t('revisions.restored'))
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('common.error')),
  })

  if (!revisions.data || revisions.data.length === 0) return null

  return (
    <div className="space-y-2 border-t pt-4">
      <h3 className="flex items-center gap-2 font-medium text-sm">
        <History className="size-4" /> {t('revisions.title')}
      </h3>
      <ul className="space-y-0.5">
        {revisions.data.map((revision) => (
          <li key={revision.id}>
            <button
              type="button"
              onClick={() => setSelected(revision)}
              className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-muted"
            >
              <span className="truncate text-muted-foreground text-xs">
                {formatDateTime(revision.createdAt)}
                {revision.createdByName ? ` · ${revision.createdByName}` : ''}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">{revision.status}</span>
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={Boolean(selected)} onOpenChange={(next) => !next && setSelected(null)}>
        <DialogContent className="max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{t('revisions.previewTitle')}</DialogTitle>
            <DialogDescription>
              {selected && formatDateTime(selected.createdAt)}
              {selected?.createdByName ? ` · ${selected.createdByName}` : ''}
            </DialogDescription>
          </DialogHeader>

          {selected && <RevisionDiff revision={selected} current={currentData} />}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={restore.isPending}
              onClick={() => selected && restore.mutate(selected.id)}
            >
              <RotateCcw className="size-4" /> {t('revisions.restore')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * The fields where a revision differs from the live entry, with the revision's values shown.
 * `diffFields` is shared with the version comparison — the same question asked of two field maps.
 */
function RevisionDiff({
  revision,
  current,
}: {
  revision: EntryRevision
  current: Record<string, unknown>
}) {
  const t = useT()
  const changes = diffFields(current, revision.data)

  if (changes.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('versions.diffIdentical')}</p>
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">{t('revisions.diffHint')}</p>
      <ul className="space-y-2">
        {changes.map((change) => (
          <li key={change.name} className="rounded border p-2 text-sm">
            <p className="font-medium">{change.name}</p>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words text-muted-foreground text-xs">
              {previewValue(change.right)}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  )
}
