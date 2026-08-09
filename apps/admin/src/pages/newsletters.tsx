import {
  NEWSLETTER_AUDIENCES,
  type Newsletter,
  type NewsletterAudience,
  type NewsletterTemplate,
} from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, Plus, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
import { TablePagination } from '@/components/table-pagination'
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
import { useKeysetPage } from '@/hooks/use-paged-query'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/i18n'
import { NewsletterPreview } from './newsletter-templates'

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
  const { formatDate } = useFormatters()
  const [editing, setEditing] = useState<Newsletter | 'new' | null>(null)
  const [sending, setSending] = useState<Newsletter | null>(null)
  const siteSlug = useActiveSiteSlug()

  const newsletters = useKeysetPage<Newsletter>({
    queryKey: ['newsletters', siteSlug],
    enabled: Boolean(siteSlug),
    fetchPage: (page) => api.newsletters.list(page),
  })

  const rows = newsletters.rows

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

        {!newsletters.isLoading && newsletters.isEmpty && (
          <EmptyState
            title="No newsletters yet"
            description="Draft your first campaign and send it to your list."
            action={<Button onClick={() => setEditing('new')}>New newsletter</Button>}
          />
        )}

        {!newsletters.isLoading && !newsletters.isEmpty && (
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
            <TablePagination state={newsletters.pagination} />
          </div>
        )}
      </div>

      <NewsletterEditor newsletter={editing} onClose={() => setEditing(null)} />
      <SendDialog newsletter={sending} onClose={() => setSending(null)} />
    </>
  )
}

/** The sentinel a Select uses for "no pick" — react's Select cannot hold a null value. */
const SITE_DEFAULT_SENDER = '__site__'

interface Draft {
  subject: string
  body: string
  audience: NewsletterAudience
  /** The chosen sender's id, or null to use the site's newsletter sender (#136). */
  senderId: string | null
}

const EMPTY: Draft = { subject: '', body: '', audience: 'both', senderId: null }

function NewsletterEditor({
  newsletter,
  onClose,
}: {
  newsletter: Newsletter | 'new' | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(EMPTY)
  // The site's address book, to pick a From from. Loaded once; empty when none are configured.
  const senders = useQuery({ queryKey: ['email-senders'], queryFn: api.email.senders })

  const isNew = newsletter === 'new'
  const existing = newsletter && newsletter !== 'new' ? newsletter : null
  const readOnly = existing !== null && existing.status !== 'draft'

  useEffect(() => {
    if (isNew) setDraft(EMPTY)
    else if (existing) {
      setDraft({
        subject: existing.subject,
        body: existing.body,
        audience: existing.audience,
        senderId: existing.senderId,
      })
    }
  }, [isNew, existing])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['newsletters'] })

  const save = useMutation({
    mutationFn: () => {
      const input = {
        subject: draft.subject,
        body: draft.body,
        audience: draft.audience,
        senderId: draft.senderId,
      }
      return isNew
        ? api.newsletters.create(input)
        : api.newsletters.update((existing as Newsletter).id, input)
    },
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
          {!readOnly && (
            <TemplatePicker
              onPick={(template) =>
                setDraft((d) => ({ ...d, subject: template.subject, body: template.body }))
              }
            />
          )}

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

          <div className="space-y-2">
            <Label htmlFor="nl-sender">From</Label>
            <Select
              value={draft.senderId ?? SITE_DEFAULT_SENDER}
              onValueChange={(value) =>
                setDraft((d) => ({
                  ...d,
                  senderId: value === SITE_DEFAULT_SENDER ? null : value,
                }))
              }
              disabled={readOnly}
            >
              <SelectTrigger id="nl-sender">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SITE_DEFAULT_SENDER}>This site's newsletter sender</SelectItem>
                {senders.data?.map((sender) => (
                  <SelectItem key={sender.id} value={sender.id}>
                    {sender.name ? `${sender.name} <${sender.email}>` : sender.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Addresses come from the site's list under Configuration → Email. Pick one to send this
              issue as yourself; leave it on the default otherwise.
            </p>
          </div>

          {draft.subject && draft.body && (
            <NewsletterPreview
              subject={draft.subject}
              body={draft.body}
              senderId={draft.senderId}
            />
          )}

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
            <div className="flex gap-2">
              <SaveAsTemplate subject={draft.subject} body={draft.body} />
              <Button
                type="button"
                disabled={save.isPending || !draft.subject || !draft.body}
                onClick={() => save.mutate()}
              >
                {isNew ? 'Create draft' : 'Save draft'}
              </Button>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Prefills the compose form from a saved template. */
function TemplatePicker({ onPick }: { onPick: (template: NewsletterTemplate) => void }) {
  const siteSlug = useActiveSiteSlug()
  const templates = useQuery({
    queryKey: ['newsletter-templates', siteSlug],
    queryFn: api.newsletterTemplates.list,
    enabled: Boolean(siteSlug),
  })

  if (!templates.data || templates.data.length === 0) return null

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-4">
      <Label>Start from a template</Label>
      <Select
        onValueChange={(id) => {
          const template = templates.data?.find((t) => t.id === id)
          if (template) onPick(template)
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder="Choose a template…" />
        </SelectTrigger>
        <SelectContent>
          {templates.data.map((template) => (
            <SelectItem key={template.id} value={template.id}>
              {template.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">Replaces the current subject and body.</p>
    </div>
  )
}

/** Saves the current subject and body as a reusable template. */
function SaveAsTemplate({ subject, body }: { subject: string; body: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: () => api.newsletterTemplates.create({ name, subject, body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['newsletter-templates'] })
      toast.success('Saved as template')
      setOpen(false)
      setName('')
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={!subject || !body}
        onClick={() => setOpen(true)}
      >
        Save as template
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              create.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>Save as template</DialogTitle>
              <DialogDescription>
                Reuse this subject and body as the starting point for future newsletters.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-4">
              <Label htmlFor="save-template-name">Template name</Label>
              <Input
                id="save-template-name"
                required
                placeholder="Monthly digest"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name}>
                Save template
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
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
