import type { EmailConfig, EmailSender } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useClientPage } from '@/hooks/use-paged-query'
import { useActiveSite } from '@/hooks/use-site'
import { ApiClientError, api } from '@/lib/api'

interface Form {
  fromEmail: string
  fromName: string
  replyTo: string
  enabled: boolean
}

function toForm(config: EmailConfig): Form {
  return {
    fromEmail: config.fromEmail ?? '',
    fromName: config.fromName ?? '',
    replyTo: config.replyTo ?? '',
    enabled: config.enabled,
  }
}

export function EmailSettingsPage() {
  return (
    <>
      <PageHeader
        title="Email"
        description="The global CMS sender every operator email goes out as, and each site's address book — the addresses it may send from, and which is its member and newsletter sender."
      />
      <div className="space-y-10 p-8">
        <CmsSenderSection />
        <SenderAddressBook />
      </div>
    </>
  )
}

/** The one deployment-wide sender — operator invites, resets, sign-in codes, review notifications. */
function CmsSenderSection() {
  const queryClient = useQueryClient()
  const config = useQuery({ queryKey: ['email-config'], queryFn: api.email.config })
  const [form, setForm] = useState<Form | null>(null)

  useEffect(() => {
    if (config.data) setForm(toForm(config.data))
  }, [config.data])

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('Not loaded')
      // Empty strings are cleared overrides, sent as null so the environment default applies again.
      return api.email.updateConfig({
        fromEmail: form.fromEmail.trim() || null,
        fromName: form.fromName.trim() || null,
        replyTo: form.replyTo.trim() || null,
        enabled: form.enabled,
      })
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['email-config'], updated)
      toast.success('CMS sender saved')
    },
    onError: (error) => toast.error(error.message),
  })

  if (config.isLoading || !form) return <Skeleton className="h-72 max-w-2xl" />

  return (
    <section className="max-w-2xl space-y-5">
      <div>
        <h2 className="font-medium text-lg">CMS sender</h2>
        <p className="text-muted-foreground text-sm">
          Used for every operator email — invites, password resets, sign-in codes, review
          notifications — and as the fallback for any site that has assigned no sender of its own.
          There is exactly one, for the whole deployment.
        </p>
      </div>

      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="email-enabled">Sending enabled</Label>
            <p className="text-muted-foreground text-sm">
              When off, Hedge still composes and logs emails but never hands them to the provider.
            </p>
          </div>
          <Switch
            id="email-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => setForm((f) => f && { ...f, enabled: checked })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="from-email">From address</Label>
            <Input
              id="from-email"
              type="email"
              placeholder={config.data?.defaultFromEmail}
              value={form.fromEmail}
              onChange={(event) => setForm((f) => f && { ...f, fromEmail: event.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              Must be on a domain onboarded with Cloudflare Email Sending. Leave blank to use{' '}
              <span className="font-medium">{config.data?.defaultFromEmail}</span>.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="from-name">From name</Label>
            <Input
              id="from-name"
              placeholder={config.data?.defaultFromName}
              value={form.fromName}
              onChange={(event) => setForm((f) => f && { ...f, fromName: event.target.value })}
            />
          </div>
        </div>

        <div className="space-y-2 sm:max-w-[calc(50%-0.5rem)]">
          <Label htmlFor="reply-to">Reply-to address</Label>
          <Input
            id="reply-to"
            type="email"
            placeholder="No reply-to"
            value={form.replyTo}
            onChange={(event) => setForm((f) => f && { ...f, replyTo: event.target.value })}
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>
            Save CMS sender
          </Button>
        </div>
      </form>
    </section>
  )
}

/** The active site's address book: its addresses, and which is the member / newsletter sender. */
function SenderAddressBook() {
  const queryClient = useQueryClient()
  const { site } = useActiveSite()
  const senders = useQuery({ queryKey: ['email-senders'], queryFn: api.email.senders })
  const paged = useClientPage(senders.data ?? [])

  const [editing, setEditing] = useState<EmailSender | 'new' | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['email-senders'] })

  const remove = useMutation({
    mutationFn: (id: string) => api.email.removeSender(id),
    onSuccess: () => {
      invalidate()
      // A delete un-points the site, so the site cache is stale too.
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success('Sender removed')
    },
    onError: (error) => toast.error(error.message),
  })

  // Assignment lives on the site; toggling one role keeps the other as it is.
  const assign = useMutation({
    mutationFn: (next: { memberSenderId: string | null; newsletterSenderId: string | null }) =>
      api.email.assignSenders(next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success('Roles updated')
    },
    onError: (error) => toast.error(error.message),
  })

  const memberId = site?.memberSenderId ?? null
  const newsletterId = site?.newsletterSenderId ?? null

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-medium text-lg">Sender addresses{site ? ` — ${site.name}` : ''}</h2>
          <p className="text-muted-foreground text-sm">
            The addresses this site may send from. Assign one as the member sender (invites, resets,
            sign-in) and one as the newsletter sender; a newsletter can also pick its own on the
            compose screen. Unassigned roles fall back to the CMS sender above.
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          Add address
        </Button>
      </div>

      {senders.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : paged.isEmpty ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm">
          No addresses yet. Add one to send this site's email as something other than the CMS
          sender.
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-28 text-center">Member</TableHead>
                <TableHead className="w-28 text-center">Newsletter</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.rows.map((sender) => (
                <TableRow key={sender.id}>
                  <TableCell className="font-medium">
                    {sender.email}
                    {sender.replyTo && (
                      <Badge variant="outline" className="ml-2 font-normal text-xs">
                        reply-to {sender.replyTo}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{sender.name ?? '—'}</TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={memberId === sender.id}
                      disabled={assign.isPending}
                      aria-label={`Use ${sender.email} as the member sender`}
                      onCheckedChange={(on) =>
                        assign.mutate({
                          memberSenderId: on ? sender.id : null,
                          newsletterSenderId: newsletterId,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={newsletterId === sender.id}
                      disabled={assign.isPending}
                      aria-label={`Use ${sender.email} as the newsletter sender`}
                      onCheckedChange={(on) =>
                        assign.mutate({
                          memberSenderId: memberId,
                          newsletterSenderId: on ? sender.id : null,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit"
                        aria-label={`Edit ${sender.email}`}
                        onClick={() => setEditing(sender)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Remove"
                        aria-label={`Remove ${sender.email}`}
                        onClick={() => remove.mutate(sender.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination state={paged.pagination} />
        </div>
      )}

      <SenderDialog sender={editing} onClose={() => setEditing(null)} onSaved={invalidate} />
    </section>
  )
}

/** Add or edit one address. `new` adds; an `EmailSender` edits it. */
function SenderDialog({
  sender,
  onClose,
  onSaved,
}: {
  sender: EmailSender | 'new' | null
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = sender === 'new'
  const existing = sender && sender !== 'new' ? sender : null
  const [form, setForm] = useState({ email: '', name: '', replyTo: '' })
  const [errors, setErrors] = useState<Record<string, string[]>>({})

  useEffect(() => {
    if (isNew) setForm({ email: '', name: '', replyTo: '' })
    else if (existing) {
      setForm({
        email: existing.email,
        name: existing.name ?? '',
        replyTo: existing.replyTo ?? '',
      })
    }
    setErrors({})
  }, [isNew, existing])

  const save = useMutation({
    mutationFn: () => {
      const input = {
        email: form.email.trim(),
        name: form.name.trim() || null,
        replyTo: form.replyTo.trim() || null,
      }
      return isNew
        ? api.email.createSender(input)
        : api.email.updateSender((existing as EmailSender).id, input)
    },
    onSuccess: () => {
      onSaved()
      toast.success(isNew ? 'Address added' : 'Address saved')
      onClose()
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.details) setErrors(error.details)
      toast.error(error.message)
    },
  })

  return (
    <Dialog open={sender !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add address' : 'Edit address'}</DialogTitle>
          <DialogDescription>
            The address must be on a domain onboarded with Cloudflare Email Sending, or a send from
            it fails at the provider.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="sender-email">Address</Label>
            <Input
              id="sender-email"
              type="email"
              required
              value={form.email}
              onChange={(event) => setForm((f) => ({ ...f, email: event.target.value }))}
            />
            {errors.email && <p className="text-destructive text-xs">{errors.email[0]}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="sender-name">From name</Label>
            <Input
              id="sender-name"
              placeholder="Optional"
              value={form.name}
              onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sender-reply-to">Reply-to address</Label>
            <Input
              id="sender-reply-to"
              type="email"
              placeholder="Optional"
              value={form.replyTo}
              onChange={(event) => setForm((f) => ({ ...f, replyTo: event.target.value }))}
            />
            {errors.replyTo && <p className="text-destructive text-xs">{errors.replyTo[0]}</p>}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !form.email.trim()}>
              {isNew ? 'Add' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
