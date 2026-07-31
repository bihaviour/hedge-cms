import type { EntryVersion, EntryVersionStatus } from '@hedge/core'
import { clearedLevels } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, GitBranch, Plus, Send, Trash2, Upload, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { diffFields, previewValue } from '@/lib/field-diff'
import { useFormatters, useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n/catalog'

/**
 * The Versions panel, above `EntryRevisions` in the editor's sidebar — the two read as a pair: what
 * this entry was, and what it may become.
 *
 * The gating here is cosmetic. Every action it hides is also refused by the server (`requireUserActor`
 * plus the caller's approval level), and both have to exist: the server check is what makes it true,
 * this is what stops the UI offering a button that 403s.
 */

const STATUS_LABEL: Record<EntryVersionStatus, MessageKey> = {
  draft: 'versions.statusDraft',
  in_review: 'versions.statusInReview',
  changes_requested: 'versions.statusChangesRequested',
  approved: 'versions.statusApproved',
  published: 'versions.statusPublished',
  discarded: 'versions.statusDiscarded',
}

/** Finished versions stay listed but stop competing for attention. */
const OPEN_STATUSES: EntryVersionStatus[] = ['draft', 'in_review', 'changes_requested', 'approved']

export function EntryVersions({
  collection,
  slug,
  locale,
  currentData,
  currentUserId,
}: {
  collection: string
  slug: string
  locale: string
  /** The editor's live form state, so a comparison against "the entry" includes unsaved edits. */
  currentData: Record<string, unknown>
  currentUserId: string
}) {
  const t = useT()
  const siteSlug = useActiveSiteSlug()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [comparing, setComparing] = useState<EntryVersion | null>(null)

  const versions = useQuery({
    queryKey: ['entry-versions', siteSlug, collection, slug, locale],
    queryFn: () => api.entryVersions.list(collection, slug, locale),
    enabled: Boolean(siteSlug),
  })

  // What this person may approve on this site. Its own query rather than a field on the session:
  // approval authority is per site, and the session is not.
  const authority = useQuery({
    queryKey: ['review-authority', siteSlug],
    queryFn: api.review.authority,
    enabled: Boolean(siteSlug),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['entry-versions', siteSlug, collection, slug] })
    queryClient.invalidateQueries({ queryKey: ['review-queue', siteSlug] })
    queryClient.invalidateQueries({ queryKey: ['review-count', siteSlug] })
  }

  const open = (versions.data ?? []).filter((version) => OPEN_STATUSES.includes(version.status))
  const closed = (versions.data ?? []).filter((version) => !OPEN_STATUSES.includes(version.status))

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-medium text-sm">
          <GitBranch className="size-4" /> {t('versions.title')}
        </h3>
        <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> {t('versions.start')}
        </Button>
      </div>

      {open.length === 0 && closed.length === 0 && (
        <p className="text-muted-foreground text-xs">{t('versions.empty')}</p>
      )}

      <ul className="space-y-1">
        {[...open, ...closed].map((version) => (
          <li key={version.id}>
            <button
              type="button"
              onClick={() => setComparing(version)}
              className="w-full space-y-1 rounded px-1.5 py-1.5 text-left hover:bg-muted"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-xs">{version.title}</span>
                <Badge variant={version.status === 'approved' ? 'default' : 'secondary'}>
                  {t(STATUS_LABEL[version.status])}
                </Badge>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                {version.createdByName ?? t('versions.unknownAuthor')}
                {version.requiredLevels > 0 && (
                  <>
                    {' · '}
                    {t('versions.cleared', {
                      cleared: clearedLevels(version.approvals),
                      required: version.requiredLevels,
                    })}
                  </>
                )}
                {version.stale && (
                  <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                    <AlertTriangle className="size-3" /> {t('versions.stale')}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <NewVersionDialog
        open={creating}
        onOpenChange={setCreating}
        collection={collection}
        slug={slug}
        locale={locale}
        onCreated={invalidate}
      />

      <VersionDialog
        version={comparing}
        onOpenChange={() => setComparing(null)}
        collection={collection}
        slug={slug}
        locale={locale}
        currentData={currentData}
        currentUserId={currentUserId}
        approvalLevel={authority.data?.approvalLevel ?? 0}
        others={(versions.data ?? []).filter((other) => other.id !== comparing?.id)}
        onChanged={invalidate}
      />
    </div>
  )
}

/** Starting a version forks the live entry; the title is what makes three of them tell apart. */
function NewVersionDialog({
  open,
  onOpenChange,
  collection,
  slug,
  locale,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  collection: string
  slug: string
  locale: string
  onCreated: () => void
}) {
  const t = useT()
  const [title, setTitle] = useState('')

  const create = useMutation({
    mutationFn: () => api.entryVersions.create(collection, slug, { title }, locale),
    onSuccess: () => {
      onCreated()
      onOpenChange(false)
      setTitle('')
      toast.success(t('versions.created'))
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('versions.newTitle')}</DialogTitle>
            <DialogDescription>{t('versions.newDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            <Label htmlFor="version-title">{t('versions.summary')}</Label>
            <Input
              id="version-title"
              required
              maxLength={200}
              placeholder={t('versions.summaryPlaceholder')}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">{t('versions.summaryHint')}</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !title.trim()}>
              {t('versions.startAction')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One version: what it changes, against the live entry or against another version, plus whichever
 * review actions are open to this person right now.
 */
function VersionDialog({
  version,
  onOpenChange,
  collection,
  slug,
  locale,
  currentData,
  currentUserId,
  approvalLevel,
  others,
  onChanged,
}: {
  version: EntryVersion | null
  onOpenChange: () => void
  collection: string
  slug: string
  locale: string
  currentData: Record<string, unknown>
  currentUserId: string
  approvalLevel: number
  others: EntryVersion[]
  onChanged: () => void
}) {
  const t = useT()
  const { formatDateTime } = useFormatters()
  const queryClient = useQueryClient()
  const [against, setAgainst] = useState('live')
  const [comment, setComment] = useState('')

  const act = useMutation({
    mutationFn: async (action: 'submit' | 'approve' | 'reject' | 'publish' | 'discard') => {
      const args = [collection, slug, version!.id] as const
      if (action === 'submit') return await api.entryVersions.submit(...args, locale)
      if (action === 'discard') return await api.entryVersions.discard(...args, locale)
      if (action === 'publish') return await api.entryVersions.publish(...args, locale)
      return await api.entryVersions.decide(...args, action, comment || undefined, locale)
    },
    onSuccess: (_result, action) => {
      onChanged()
      if (action === 'publish') {
        // Publishing rewrote the live row, so the editor has to reseed from it.
        queryClient.invalidateQueries({ queryKey: ['entry'] })
        queryClient.invalidateQueries({ queryKey: ['entries', collection] })
      }
      setComment('')
      onOpenChange()
      toast.success(t(`versions.done.${action}` as MessageKey))
    },
    onError: (error) => toast.error(error.message),
  })

  if (!version) return null

  const comparison = others.find((other) => other.id === against)
  const left = comparison ? comparison.data : currentData
  const changes = diffFields(left, version.data)
  const cleared = clearedLevels(version.approvals)

  const isAuthor = version.createdBy === currentUserId
  const alreadyDecided = version.approvals.some((approval) => approval.userId === currentUserId)
  // The same rule `decideEntryVersion` applies, mirrored so the buttons match what the server allows.
  const canDecide =
    version.status === 'in_review' && !isAuthor && !alreadyDecided && approvalLevel >= cleared + 1
  const canPublish =
    version.status !== 'published' &&
    version.status !== 'discarded' &&
    cleared >= version.requiredLevels &&
    approvalLevel >= (version.requiredLevels || 1)
  const canSubmit = version.status === 'draft' || version.status === 'changes_requested'

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{version.title}</DialogTitle>
          <DialogDescription>
            {version.createdByName ?? t('versions.unknownAuthor')} ·{' '}
            {formatDateTime(version.createdAt)} · {t(STATUS_LABEL[version.status])}
          </DialogDescription>
        </DialogHeader>

        {version.stale && (
          <p className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
            {t('versions.staleHint')}
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="version-compare">{t('versions.compareAgainst')}</Label>
          <Select value={against} onValueChange={setAgainst}>
            <SelectTrigger id="version-compare">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">{t('versions.compareLive')}</SelectItem>
              {others.map((other) => (
                <SelectItem key={other.id} value={other.id}>
                  {other.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <VersionDiff changes={changes} />

        {version.approvals.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="font-medium text-sm">{t('versions.trail')}</p>
            <ul className="space-y-1">
              {version.approvals.map((approval) => (
                <li key={approval.id} className="text-muted-foreground text-xs">
                  {approval.decision === 'approved' ? '✓' : '✕'}{' '}
                  {t('versions.trailEntry', {
                    name: approval.userName ?? t('versions.unknownAuthor'),
                    level: approval.level,
                  })}
                  {approval.comment ? ` — “${approval.comment}”` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {canDecide && (
          <div className="space-y-2 border-t pt-3">
            <Label htmlFor="version-comment">{t('versions.comment')}</Label>
            <Textarea
              id="version-comment"
              rows={2}
              placeholder={t('versions.commentPlaceholder')}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </div>
        )}

        {version.status === 'in_review' && !canDecide && (
          <p className="text-muted-foreground text-xs">
            {isAuthor
              ? t('versions.cannotReviewOwn')
              : alreadyDecided
                ? t('versions.alreadyDecided')
                : t('versions.levelTooLow', { level: cleared + 1 })}
          </p>
        )}

        <DialogFooter className="flex-wrap">
          {canSubmit && (
            <Button variant="outline" disabled={act.isPending} onClick={() => act.mutate('submit')}>
              <Send className="size-4" /> {t('versions.submit')}
            </Button>
          )}
          {version.status !== 'published' && version.status !== 'discarded' && (
            <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate('discard')}>
              <Trash2 className="size-4" /> {t('versions.discard')}
            </Button>
          )}
          {canDecide && (
            <>
              <Button
                variant="outline"
                disabled={act.isPending}
                onClick={() => act.mutate('reject')}
              >
                <X className="size-4" /> {t('versions.reject')}
              </Button>
              <Button disabled={act.isPending} onClick={() => act.mutate('approve')}>
                <Check className="size-4" /> {t('versions.approve')}
              </Button>
            </>
          )}
          {canPublish && (
            <Button disabled={act.isPending} onClick={() => act.mutate('publish')}>
              <Upload className="size-4" /> {t('versions.publish')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Field by field, both sides side by side. For the two-writers case this is the useful reading:
 * which fields the second writer touched, and which they left exactly as they found them.
 */
export function VersionDiff({ changes }: { changes: ReturnType<typeof diffFields> }) {
  const t = useT()

  if (changes.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('versions.diffIdentical')}</p>
  }

  return (
    <ul className="space-y-2">
      {changes.map((change) => (
        <li key={change.name} className="rounded border p-2">
          <p className="flex items-center gap-2 font-medium text-sm">
            {change.name}
            <Badge variant="secondary">{t(`versions.change.${change.kind}` as MessageKey)}</Badge>
          </p>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground text-xs">{t('versions.diffBefore')}</p>
              <pre className="overflow-auto whitespace-pre-wrap break-words text-muted-foreground text-xs">
                {previewValue(change.left)}
              </pre>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">{t('versions.diffAfter')}</p>
              <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
                {previewValue(change.right)}
              </pre>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
