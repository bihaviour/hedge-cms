import type { Member } from '@hedge/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Ban, CircleCheck, Send, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useKeysetPage } from '@/hooks/use-paged-query'
import { useActiveSite } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'

/**
 * Members are the audience of the current site — people who sign in on the website itself to
 * unlock members-only entries. They have no access to this admin.
 */
export function MembersPage() {
  const t = useT()
  const { formatDate } = useFormatters()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const queryClient = useQueryClient()
  const { site } = useActiveSite()

  const members = useKeysetPage<Member & { pending: boolean }>({
    queryKey: ['members', site?.slug, search],
    enabled: Boolean(site),
    fetchPage: (page) => api.members.list({ ...page, ...(search ? { q: search } : {}) }),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'blocked' }) =>
      api.members.update(id, { status }),
    onSuccess: (member) => {
      queryClient.invalidateQueries({ queryKey: ['members'] })
      toast.success(member.status === 'blocked' ? 'Member blocked' : 'Member unblocked')
    },
    onError: (error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: api.members.remove,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] })
      toast.success('Member removed')
    },
    onError: (error) => toast.error(error.message),
  })

  const resend = useMutation({
    mutationFn: api.members.invite,
    onSuccess: () => toast.success('Invite sent again'),
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title={t('members.title')}
        description={t('members.subtitle')}
        actions={
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="size-4" />
            {t('members.invite')}
          </Button>
        }
      />

      <div className="space-y-4 p-8">
        <Input
          placeholder={t('members.searchPlaceholder')}
          value={search}
          className="max-w-xs"
          onChange={(event) => setSearch(event.target.value)}
        />

        {members.isLoading && <Skeleton className="h-64 w-full" />}

        {!members.isLoading && members.isEmpty && (
          <EmptyState
            title={t('members.emptyTitle')}
            description={
              site?.allowMemberSignup
                ? 'Visitors can register themselves at POST /api/v1/member/register, or you can invite one here.'
                : 'Signup is off for this site, so members can only be invited from here.'
            }
            action={<Button onClick={() => setOpen(true)}>{t('members.inviteAction')}</Button>}
          />
        )}

        {!members.isLoading && !members.isEmpty && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('members.colName')}</TableHead>
                  <TableHead>{t('members.colEmail')}</TableHead>
                  <TableHead className="w-28">{t('members.colStatus')}</TableHead>
                  <TableHead className="w-32">{t('members.colLastSignIn')}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.rows.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">{member.name}</TableCell>
                    <TableCell className="text-muted-foreground">{member.email}</TableCell>
                    <TableCell>
                      {/* Invited but not yet arrived: the account exists, the password does not. */}
                      <Badge
                        variant={
                          member.pending || member.status === 'blocked' ? 'outline' : 'secondary'
                        }
                      >
                        {member.pending ? 'invited' : member.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(member.lastLoginAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {member.pending && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Resend the invite to ${member.email}`}
                            title="Resend invite"
                            disabled={resend.isPending}
                            onClick={() => resend.mutate(member.id)}
                          >
                            <Send className="size-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={
                            member.status === 'active'
                              ? `Block ${member.email}`
                              : `Unblock ${member.email}`
                          }
                          onClick={() =>
                            setStatus.mutate({
                              id: member.id,
                              status: member.status === 'active' ? 'blocked' : 'active',
                            })
                          }
                        >
                          {member.status === 'active' ? (
                            <Ban className="size-4" />
                          ) : (
                            <CircleCheck className="size-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${member.email}`}
                          onClick={() => remove.mutate(member.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TablePagination state={members.pagination} />
          </div>
        )}
      </div>

      <AddMemberDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function AddMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', email: '' })

  const create = useMutation({
    mutationFn: api.members.create,
    onSuccess: (member) => {
      queryClient.invalidateQueries({ queryKey: ['members'] })
      toast.success(
        member.pending
          ? `Invite sent to ${member.email}`
          : `${member.name} already had an account and now reads this site too`,
      )
      onOpenChange(false)
      setForm({ name: '', email: '' })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate(form)
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They get an email with a link to choose their own password. You never set one for
              them.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="member-name">Name</Label>
              <Input
                id="member-name"
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="member-email">Email</Label>
              <Input
                id="member-email"
                type="email"
                required
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !form.email}>
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
