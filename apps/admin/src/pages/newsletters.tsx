import { NEWSLETTER_AUDIENCES, type Newsletter, type NewsletterAudience } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, Plus, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'

const AUDIENCE_LABEL: Record<NewsletterAudience, string> = {
  subscribers: 'Subscribers',
  members: 'Members',
  both: 'Subscribers + members',
}

const STATUS_VARIANT: Record<Newsletter['status'], 'default' | 'secondary' | 'outline'> = {
  draft: 'outline',
  sending: 'secondary',
  sent: 'default',
}

export function NewslettersPage() {
  const [editing, setEditing] = useState<Newsletter | 'new' | null>(null)
  const [sending, setSending] = useState<Newsletter | null>(null)
  const siteSlug = useActiveSiteSlug()

  const newsletters = useQuery({
    queryKey: ['newsletters', siteSlug],
    queryFn: () => api.newsletters.list(),
    enabled: Boolean(siteSlug),
  })

  const rows = newsletters.data?.data ?? []

  return (
    <>
      <PageHeader
        title="Newsletters"
        description="Compose and send email campaigns to this site's subscribers and members."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            New newsletter
          </Button>
        }
      />

      <div className="p-8">
        {newsletters.isLoading && <Skeleton className="h-48 w-full" />}

        {!newsletters.isLoading && rows.length === 0 && (
          <EmptyState
            title="No newsletters yet"
            description="Draft your first campaign and send it to your list."
            action={<Button onClick={() => setEditing('new')}>New newsletter</Button>}
          />
        )}

        {rows.length > 0 && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-48">Audience</TableHead>
                  <TableHead className="w-28">Recipients</TableHead>
                  <TableHead className="w-32">Sent</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((newsletter) => (
                  <TableRow key={newsletter.id}>
                    <TableCell className="font-medium">{newsletter.subject}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[newsletter.status]}>{newsletter.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {AUDIENCE_LABEL[newsletter.audience]}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {newsletter.recipientCount ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(newsletter.sentAt)}
                    </TableCell>
                    <TableCell className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(newsletter)}>
                        {newsletter.status === 'draft' ? 'Edit' : 'View'}
                      </Button>
                      {newsletter.status === 'draft' && (
                        <Button variant="ghost" size="sm" onClick={() => setSending(newsletter)}>
                          <Send className="size-4" />
                          Send
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <NewsletterEditor newsletter={editing} onClose={() => setEditing(null)} />
      <SendDialog newsletter={sending} onClose={() => setSending(null)} />
    </>
  )
}

interface Draft {
  subject: string
  body: string
  audience: NewsletterAudience
}

const EMPTY: Draft = { subject: '', body: '', audience: 'both' }

function NewsletterEditor({
  newsletter,
  onClose,
}: {
  newsletter: Newsletter | 'new' | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(EMPTY)

  const isNew = newsletter === 'new'
  const existing = newsletter && newsletter !== 'new' ? newsletter : null
  const readOnly = existing !== null && existing.status !== 'draft'

  useEffect(() => {
    if (isNew) setDraft(EMPTY)
    else if (existing) {
      setDraft({ subject: existing.subject, body: existing.body, audience: existing.audience })
    }
  }, [isNew, existing])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['newsletters'] })

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.newsletters.create(draft)
        : api.newsletters.update((existing as Newsletter).id, draft),
    onSuccess: () => {
      invalidate()
      toast.success(isNew ? 'Draft created' : 'Draft saved')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: () => api.newsletters.remove((existing as Newsletter).id),
    onSuccess: () => {
      invalidate()
      toast.success('Newsletter deleted')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Sheet open={newsletter !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isNew ? 'New newsletter' : existing?.subject}</SheetTitle>
          <SheetDescription>
            {readOnly
              ? 'This newsletter has been sent and can no longer be edited.'
              : 'Compose your campaign. HTML is allowed in the body.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 px-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="nl-subject">Subject</Label>
            <Input
              id="nl-subject"
              disabled={readOnly}
              value={draft.subject}
              onChange={(event) => setDraft((d) => ({ ...d, subject: event.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nl-audience">Audience</Label>
            <Select
              value={draft.audience}
              onValueChange={(value) =>
                setDraft((d) => ({ ...d, audience: value as NewsletterAudience }))
              }
              disabled={readOnly}
            >
              <SelectTrigger id="nl-audience">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NEWSLETTER_AUDIENCES.map((audience) => (
                  <SelectItem key={audience} value={audience}>
                    {AUDIENCE_LABEL[audience]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="nl-body">Body</Label>
            <Textarea
              id="nl-body"
              rows={12}
              disabled={readOnly}
              value={draft.body}
              onChange={(event) => setDraft((d) => ({ ...d, body: event.target.value }))}
            />
          </div>

          {existing && <TestSend id={existing.id} disabled={save.isPending} />}
        </div>

        {!readOnly && (
          <SheetFooter className="flex-row justify-between gap-2">
            {existing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              disabled={save.isPending || !draft.subject || !draft.body}
              onClick={() => save.mutate()}
            >
              {isNew ? 'Create draft' : 'Save draft'}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

function TestSend({ id, disabled }: { id: string; disabled: boolean }) {
  const [email, setEmail] = useState('')
  const test = useMutation({
    mutationFn: () => api.newsletters.test(id, email),
    onSuccess: () => toast.success('Test email sent'),
    onError: (error) => toast.error(error.message),
  })

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <Label htmlFor="nl-test">Send a test</Label>
      <div className="flex gap-2">
        <Input
          id="nl-test"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || test.isPending || !email}
          onClick={() => test.mutate()}
        >
          <Mail className="size-4" />
          Test
        </Button>
      </div>
    </div>
  )
}

function SendDialog({
  newsletter,
  onClose,
}: {
  newsletter: Newsletter | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()

  const count = useQuery({
    queryKey: ['recipient-count', newsletter?.id, newsletter?.audience],
    queryFn: () => api.newsletters.recipientCount((newsletter as Newsletter).audience),
    enabled: newsletter !== null,
  })

  const send = useMutation({
    mutationFn: () => api.newsletters.send((newsletter as Newsletter).id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['newsletters'] })
      toast.success(
        `Sent to ${result.recipientCount} recipient${result.recipientCount === 1 ? '' : 's'}` +
          (result.failed ? ` (${result.failed} failed)` : ''),
      )
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={newsletter !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send this newsletter?</DialogTitle>
          <DialogDescription>
            "{newsletter?.subject}" will be sent to{' '}
            {count.data ? (
              <span className="font-medium text-foreground">
                {count.data.count} recipient{count.data.count === 1 ? '' : 's'}
              </span>
            ) : (
              'its audience'
            )}
            . This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={send.isPending || count.data?.count === 0}
            onClick={() => send.mutate()}
          >
            <Send className="size-4" />
            {send.isPending ? 'Sending…' : 'Send now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
