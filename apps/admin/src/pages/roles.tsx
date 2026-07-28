import {
  INSTANCE_PERMISSION_LABELS,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type RoleDefinition,
  SITE_ROLES,
  type SiteRole,
  slugify,
} from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
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
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useSession } from '@/hooks/use-session'
import { api } from '@/lib/api'

const NO_SITE_ROLE = 'none'

/**
 * Instance roles. The four built-ins are shown read-only — their powers are fixed so nobody can
 * edit themselves out of control — and operators define their own beside them. A role can only be
 * given permissions the person defining it already holds, so the editor disables the rest.
 */
export function RolesPage() {
  const session = useSession()
  const queryClient = useQueryClient()
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles.list })
  const [editing, setEditing] = useState<RoleDefinition | null>(null)
  const [creating, setCreating] = useState(false)

  const remove = useMutation({
    mutationFn: api.roles.remove,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roles'] })
      toast.success('Role deleted')
    },
    onError: (error) => toast.error(error.message),
  })

  const held = session.data?.permissions ?? []

  return (
    <>
      <PageHeader
        title="Roles"
        description="Define the roles you can assign to users, and the deployment permissions each one carries."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New role
          </Button>
        }
      />

      <div className="p-8">
        {roles.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-32">Slug</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead className="w-28">Default site</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.data?.map((role) => (
                  <TableRow key={role.slug}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        {role.name}
                        {role.builtin && (
                          <Badge variant="secondary" className="gap-1">
                            <Lock className="size-3" />
                            Built-in
                          </Badge>
                        )}
                      </span>
                      {role.description && (
                        <span className="block text-muted-foreground text-xs">
                          {role.description}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs">
                      {role.slug}
                    </TableCell>
                    <TableCell>
                      {role.permissions.length === 0 ? (
                        <span className="text-muted-foreground text-sm">Site access only</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {role.permissions.map((permission) => (
                            <Badge key={permission} variant="outline" className="font-mono text-xs">
                              {permission}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm capitalize">
                      {role.defaultSiteRole ?? 'All sites'}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {!role.builtin && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${role.name}`}
                              onClick={() => setEditing(role)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${role.name}`}
                              disabled={remove.isPending}
                              onClick={() => remove.mutate(role.slug)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
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

      <RoleDialog
        open={creating || editing !== null}
        role={editing}
        heldPermissions={held}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setEditing(null)
          }
        }}
      />
    </>
  )
}

interface RoleForm {
  name: string
  slug: string
  description: string
  permissions: InstancePermission[]
  defaultSiteRole: SiteRole | typeof NO_SITE_ROLE
}

const emptyForm: RoleForm = {
  name: '',
  slug: '',
  description: '',
  permissions: [],
  defaultSiteRole: 'editor',
}

/** Create-or-edit. A missing `role` is a create; slug is only editable then, being permanent after. */
function RoleDialog({
  open,
  role,
  heldPermissions,
  onOpenChange,
}: {
  open: boolean
  role: RoleDefinition | null
  heldPermissions: string[]
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<RoleForm>(emptyForm)
  // The slug tracks the name until the user types one of their own, so the common case needs no thought.
  const [slugEdited, setSlugEdited] = useState(false)

  useEffect(() => {
    if (!open) return
    if (role) {
      setForm({
        name: role.name,
        slug: role.slug,
        description: role.description,
        permissions: role.permissions,
        defaultSiteRole: role.defaultSiteRole ?? NO_SITE_ROLE,
      })
      setSlugEdited(true)
    } else {
      setForm(emptyForm)
      setSlugEdited(false)
    }
  }, [open, role])

  const save = useMutation({
    mutationFn: async () => {
      const defaultSiteRole = form.defaultSiteRole === NO_SITE_ROLE ? null : form.defaultSiteRole
      if (role) {
        return api.roles.update(role.slug, {
          name: form.name,
          description: form.description,
          permissions: form.permissions,
          defaultSiteRole,
        })
      }
      return api.roles.create({
        slug: form.slug,
        name: form.name,
        description: form.description,
        permissions: form.permissions,
        defaultSiteRole,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roles'] })
      toast.success(role ? 'Role updated' : 'Role created')
      onOpenChange(false)
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{role ? `Edit ${role.name}` : 'New role'}</DialogTitle>
            <DialogDescription>
              A role bundles the deployment permissions its holders get. You can only grant
              permissions you hold yourself.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                required
                placeholder="Content manager"
                value={form.name}
                onChange={(event) => {
                  const name = event.target.value
                  setForm((current) => ({
                    ...current,
                    name,
                    slug: slugEdited ? current.slug : slugify(name),
                  }))
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role-slug">Slug</Label>
              <Input
                id="role-slug"
                required
                disabled={role !== null}
                placeholder="content-manager"
                value={form.slug}
                onChange={(event) => {
                  setSlugEdited(true)
                  setForm((current) => ({ ...current, slug: event.target.value }))
                }}
              />
              <p className="text-muted-foreground text-xs">
                {role
                  ? 'The slug is permanent — it is how users reference this role.'
                  : 'Used to reference the role internally. Cannot be changed later.'}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="role-description">Description</Label>
              <Textarea
                id="role-description"
                rows={2}
                placeholder="What this role is for."
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role-default-site">Default site access</Label>
              <Select
                value={form.defaultSiteRole}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    defaultSiteRole: value as SiteRole | typeof NO_SITE_ROLE,
                  }))
                }
              >
                <SelectTrigger id="role-default-site">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SITE_ROLE}>None</SelectItem>
                  {SITE_ROLES.map((siteRole) => (
                    <SelectItem key={siteRole} value={siteRole} className="capitalize">
                      {siteRole}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                The site role a new user is granted on the site they are invited from — unless this
                role can already reach every site.
              </p>
            </div>

            <div className="space-y-3">
              <Label>Permissions</Label>
              {INSTANCE_PERMISSIONS.map((permission) => {
                const canGrant = heldPermissions.includes(permission)
                return (
                  <div key={permission} className="flex items-start justify-between gap-3 text-sm">
                    <Label htmlFor={`perm-${permission}`} className="font-normal">
                      <span className="font-mono text-xs">{permission}</span>
                      <span className="block text-muted-foreground text-xs">
                        {INSTANCE_PERMISSION_LABELS[permission]}
                        {!canGrant && ' — you do not hold this permission'}
                      </span>
                    </Label>
                    <Switch
                      id={`perm-${permission}`}
                      disabled={!canGrant}
                      checked={form.permissions.includes(permission)}
                      onCheckedChange={(checked) =>
                        setForm((current) => ({
                          ...current,
                          permissions: checked
                            ? [...current.permissions, permission]
                            : current.permissions.filter((p) => p !== permission),
                        }))
                      }
                    />
                  </div>
                )
              })}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !form.name || !form.slug}>
              {role ? 'Save changes' : 'Create role'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
