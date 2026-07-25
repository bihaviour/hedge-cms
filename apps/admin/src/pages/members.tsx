import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, CircleCheck, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useActiveSite } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'

/**
 * Members are the audience of the current site — people who sign in on the website itself to
 * unlock members-only entries. They have no access to this admin.
 */
export function MembersPage() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const queryClient = useQueryClient()
  const { site } = useActiveSite()

  const members = useQuery({
    queryKey: ['members', site?.slug, search],
    queryFn: () => api.members.list(search ? { q: search } : {}),
    enabled: Boolean(site),
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

  return (
    <>
      <PageHeader
        title="Members"
        description={
          site
            ? `People who sign in on ${site.name} to read members-only content.`
            : 'People who sign in on this site to read members-only content.'
        }
        actions={
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="size-4" />
            Add member
          </Button>
        }
      />

      <div className="space-y-4 p-8">
        <Input
          placeholder="Search by email…"
          value={search}
          className="max-w-xs"
          onChange={(event) => setSearch(event.target.value)}
        />

        {members.isLoading && <Skeleton className="h-64 w-full" />}

        {members.data?.data.length === 0 && (
          <EmptyState
            title="No members yet"
            description={
              site?.allowMemberSignup
                ? 'Visitors can register themselves at POST /api/v1/member/register, or you can add one here.'
                : 'Signup is off for this site, so members can only be added here.'
            }
            action={<Button onClick={() => setOpen(true)}>Add a member</Button>}
          />
        )}

        {members.data && members.data.data.length > 0 && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-32">Last sign-in</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data.data.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">{member.name}</TableCell>
                    <TableCell className="text-muted-foreground">{member.email}</TableCell>
                    <TableCell>
                      <Badge variant={member.status === 'active' ? 'secondary' : 'outline'}>
                        {member.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(member.lastLoginAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
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
  const [form, setForm] = useState({ name: '', email: '', password: '' })

  const create = useMutation({
    mutationFn: api.members.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] })
      toast.success('Member added')
      onOpenChange(false)
      setForm({ name: '', email: '', password: '' })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate({
              name: form.name,
              email: form.email,
              ...(form.password ? { password: form.password } : {}),
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a member</DialogTitle>
            <DialogDescription>
              Leave the password empty and they can claim the account by registering on the site
              with this email.
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
            <div className="space-y-2">
              <Label htmlFor="member-password">Password (optional)</Label>
              <Input
                id="member-password"
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
              <p className="text-muted-foreground text-xs">At least 12 characters if set.</p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !form.email}>
              Add member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
