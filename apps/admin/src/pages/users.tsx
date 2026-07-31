import { approvalLevelForSiteRole, SITE_ROLES, type SiteRole, type User } from '@hedge/core'
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
import { useFormatters, useT } from '@/lib/i18n'

export function UsersPage() {
  const t = useT()
  const { formatDate } = useFormatters()
  const [open, setOpen] = useState(false)
  const [accessFor, setAccessFor] = useState<User | null>(null)
  const queryClient = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list })
  // The assignable roles — built-ins plus any the deployment has defined under Settings → Roles.
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles.list })

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
        title={t('users.title')}
        description={t('users.subtitle')}
        actions={
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="size-4" />
            {t('users.invite')}
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
                  <TableHead>{t('users.colName')}</TableHead>
                  <TableHead>{t('users.colEmail')}</TableHead>
                  <TableHead className="w-40">{t('users.colRole')}</TableHead>
                  <TableHead className="w-44">{t('users.colSiteAccess')}</TableHead>
                  <TableHead className="w-32">{t('users.colAdded')}</TableHead>
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
                          {t('users.pending')}
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
                          {roles.data?.map((role) => (
                            <SelectItem key={role.slug} value={role.slug}>
                              {role.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {user.permissions.includes('sites:access_all') ? (
                        <span className="text-muted-foreground text-sm">{t('users.allSites')}</span>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => setAccessFor(user)}>
                          <KeySquare className="size-4" />
                          {t('users.manage')}
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
  const t = useT()
  const queryClient = useQueryClient()
  const { sites } = useActiveSite()

  const access = useQuery({
    queryKey: ['user-site-access', user?.id],
    queryFn: () => api.users.siteAccess(user!.id),
    enabled: Boolean(user),
  })

  const update = useMutation({
    mutationFn: async ({
      siteId,
      role,
      approvalLevel,
    }: {
      siteId: string
      role: SiteRole | 'none'
      approvalLevel?: number | null
    }) => {
      if (role === 'none') await api.users.revokeSite(user!.id, siteId)
      else await api.users.grantSite(user!.id, siteId, role, approvalLevel)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-site-access', user?.id] })
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success('Access updated')
    },
    onError: (error) => toast.error(error.message),
  })

  const grantFor = (siteId: string) => access.data?.find((grant) => grant.siteId === siteId)

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Site access</DialogTitle>
          <DialogDescription>
            Which sites {user?.name} can reach, as what, and what they may approve. A site with no
            access does not appear in their site switcher at all.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {access.isLoading && <Skeleton className="h-24 w-full" />}

          {access.data &&
            sites.map((site) => {
              const grant = grantFor(site.id)
              return (
                <div key={site.id} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">{site.name}</p>
                      <p className="truncate font-mono text-muted-foreground text-xs">
                        {site.slug}
                      </p>
                    </div>
                    <Select
                      value={grant?.role ?? 'none'}
                      disabled={update.isPending}
                      onValueChange={(role) =>
                        update.mutate({ siteId: site.id, role: role as SiteRole | 'none' })
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

                  {/* Approval authority sits beside the role it defaults from, so "this is managed
                      per user" has one obvious home. Only meaningful where a grant exists. */}
                  {grant && (
                    <div className="flex items-center justify-between gap-3 pl-3">
                      <p className="text-muted-foreground text-xs">{t('users.approvalLevel')}</p>
                      <Select
                        value={
                          grant.approvalLevel === null ? 'inherit' : String(grant.approvalLevel)
                        }
                        disabled={update.isPending}
                        onValueChange={(value) =>
                          update.mutate({
                            siteId: site.id,
                            role: grant.role,
                            approvalLevel: value === 'inherit' ? null : Number(value),
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inherit">
                            {t('users.approvalInherit', {
                              level: approvalLevelForSiteRole(grant.role),
                            })}
                          </SelectItem>
                          <SelectItem value="0">{t('users.approvalNone')}</SelectItem>
                          <SelectItem value="1">{t('users.approvalLevel1')}</SelectItem>
                          <SelectItem value="2">{t('users.approvalLevel2')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )
            })}

          {/* A role carrying `sites:access_all` has no `site_users` row to write to, so its level is
              shown as what it derives to rather than as a control that would save nothing. */}
          {user?.permissions.includes('sites:access_all') && (
            <p className="text-muted-foreground text-sm">{t('users.approvalAllSites')}</p>
          )}

          <p className="text-muted-foreground text-xs">{t('users.approvalHint')}</p>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t('common.done')}</Button>
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
  // The owner role is never handed out by invite — the first owner comes from setup.
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles.list })
  const assignable = roles.data?.filter((role) => role.slug !== 'owner') ?? []

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
                  {assignable.map((role) => (
                    <SelectItem key={role.slug} value={role.slug}>
                      {role.name}
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
