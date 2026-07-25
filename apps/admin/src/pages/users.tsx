import { ROLES, roleAtLeast, SITE_ROLES, type SiteRole, type User } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeySquare, Send, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
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

export function UsersPage() {
  const [open, setOpen] = useState(false)
  const [accessFor, setAccessFor] = useState<User | null>(null)
  const queryClient = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list })

  const remove = useMutation({
    mutationFn: api.users.remove,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('User removed')
    },
    onError: (error) => toast.error(error.message),
  })

  const resend = useMutation({
    mutationFn: api.auth.resendInvite,
    onSuccess: () => toast.success('Invite sent again'),
    onError: (error) => toast.error(error.message),
  })

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api.users.update(id, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Role updated')
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title="Users"
        description="People who can sign in to the CMS. Owners and admins run the whole instance; editors and viewers only reach the sites they are granted."
        actions={
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="size-4" />
            Invite user
          </Button>
        }
      />

      <div className="p-8">
        {users.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="w-40">Role</TableHead>
                  <TableHead className="w-44">Site access</TableHead>
                  <TableHead className="w-32">Joined</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data?.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      {user.name}
                      {user.pending && (
                        <Badge variant="secondary" className="ml-2">
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <Select
                        value={user.role}
                        disabled={user.role === 'owner'}
                        onValueChange={(role) => updateRole.mutate({ id: user.id, role })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((role) => (
                            <SelectItem key={role} value={role} className="capitalize">
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {roleAtLeast(user.role, 'admin') ? (
                        <span className="text-muted-foreground text-sm">All sites</span>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => setAccessFor(user)}>
                          <KeySquare className="size-4" />
                          Manage
                        </Button>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {user.pending && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Resend the invite to ${user.email}`}
                            title="Resend invite"
                            disabled={resend.isPending}
                            onClick={() => resend.mutate(user.id)}
                          >
                            <Send className="size-4" />
                          </Button>
                        )}
                        {user.role !== 'owner' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${user.name}`}
                            onClick={() => remove.mutate(user.id)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <InviteDialog open={open} onOpenChange={setOpen} />
      <SiteAccessDialog user={accessFor} onOpenChange={() => setAccessFor(null)} />
    </>
  )
}

/**
 * Per-site grants for one editor or viewer. "No access" is the absence of a grant, which is why
 * clearing a row deletes it rather than storing an empty role.
 */
function SiteAccessDialog({
  user,
  onOpenChange,
}: {
  user: User | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { sites } = useActiveSite()

  const access = useQuery({
    queryKey: ['user-site-access', user?.id],
    queryFn: () => api.users.siteAccess(user!.id),
    enabled: Boolean(user),
  })

  const setRole = useMutation({
    mutationFn: async ({ siteId, role }: { siteId: string; role: SiteRole | 'none' }) => {
      if (role === 'none') await api.users.revokeSite(user!.id, siteId)
      else await api.users.grantSite(user!.id, siteId, role)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-site-access', user?.id] })
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success('Access updated')
    },
    onError: (error) => toast.error(error.message),
  })

  const roleFor = (siteId: string) =>
    access.data?.find((grant) => grant.siteId === siteId)?.role ?? 'none'

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Site access</DialogTitle>
          <DialogDescription>
            Which sites {user?.name} can reach, and as what. A site with no access does not appear
            in their site switcher at all.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          {access.isLoading && <Skeleton className="h-24 w-full" />}

          {access.data &&
            sites.map((site) => (
              <div key={site.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{site.name}</p>
                  <p className="truncate font-mono text-muted-foreground text-xs">{site.slug}</p>
                </div>
                <Select
                  value={roleFor(site.id)}
                  disabled={setRole.isPending}
                  onValueChange={(role) =>
                    setRole.mutate({ siteId: site.id, role: role as SiteRole | 'none' })
                  }
                >
                  <SelectTrigger className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No access</SelectItem>
                    {SITE_ROLES.map((role) => (
                      <SelectItem key={role} value={role} className="capitalize">
                        {role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', email: '', role: 'editor' })

  const invite = useMutation({
    mutationFn: api.auth.invite,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Invite sent')
      onOpenChange(false)
      setForm({ name: '', email: '', role: 'editor' })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            invite.mutate(form)
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite a user</DialogTitle>
            <DialogDescription>
              They will get an email with a link to set their password.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite-name">Name</Label>
              <Input
                id="invite-name"
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.filter((role) => role !== 'owner').map((role) => (
                    <SelectItem key={role} value={role} className="capitalize">
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
