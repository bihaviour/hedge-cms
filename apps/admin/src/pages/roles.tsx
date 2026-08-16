import {
  INSTANCE_PERMISSION_LABELS,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type RoleDefinition,
  type RolePermissions,
  SITE_ROLES,
  type SiteRole,
  slugify,
} from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
import { PermissionMatrix } from '@/components/permission-matrix'
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
import { useClientPage } from '@/hooks/use-paged-query'
import { useSession } from '@/hooks/use-session'
import { api } from '@/lib/api'

const NO_SITE_ROLE = 'none'

/**
 * Roles, at both levels, because a person holds one role and it answers every question about them.
 *
 * The **deployment** half of a built-in is fixed in code so nobody can edit themselves out of
 * control. Its **site** half — the matrix — is editable on every role including the built-ins
 * (#151): "an editor may write but not delete" is the change operators come to make, and no edit
 * to it can lock a deployment out, because an instance owner reaches every site without consulting
 * a role at all. A role can only carry deployment permissions the person defining it already holds,
 * so the editor disables the rest.
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
  // Returned whole by the API, so a page here is a local slice — same bar, no request (#124).
  const paged = useClientPage(roles.data ?? [])

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
                  <TableHead>Deployment permissions</TableHead>
                  <TableHead className="w-40">On a site</TableHead>
                  <TableHead className="w-28">Default site</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.rows.map((role) => (
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
                    <TableCell className="text-muted-foreground text-sm">
                      <SiteMatrixSummary permissions={role.sitePermissions} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm capitalize">
                      {role.defaultSiteRole ?? 'All sites'}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {/* A built-in is editable too now — its matrix is, and the dialog disables
                            the deployment half rather than hiding the whole role behind a lock. */}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${role.name}`}
                          onClick={() => setEditing(role)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        {!role.builtin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${role.name}`}
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(role.slug)}
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
            <TablePagination state={paged.pagination} />
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

/** Three counts rather than 29 badges — the matrix itself is one click away in the editor. */
function SiteMatrixSummary({ permissions }: { permissions: RolePermissions }) {
  if (permissions.site.length === 0) return <span>No site access</span>
  return (
    <span className="font-mono text-xs">
      {permissions.site.length} · MCP {permissions.mcp.length} · keys {permissions.apiKey.length}
    </span>
  )
}

interface RoleForm {
  name: string
  slug: string
  description: string
  permissions: InstancePermission[]
  defaultSiteRole: SiteRole | typeof NO_SITE_ROLE
  sitePermissions: RolePermissions
}

const emptyForm: RoleForm = {
  name: '',
  slug: '',
  description: '',
  permissions: [],
  defaultSiteRole: 'editor',
  sitePermissions: { site: [], mcp: [], apiKey: [] },
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
        sitePermissions: role.sitePermissions,
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
        // A built-in sends its matrix and nothing else: the API refuses any other field on one, and
        // sending the values back unchanged would turn a refusal into a silent no-op if that ever
        // stopped being true.
        return api.roles.update(
          role.slug,
          role.builtin
            ? { sitePermissions: form.sitePermissions }
            : {
                name: form.name,
                description: form.description,
                permissions: form.permissions,
                defaultSiteRole,
                sitePermissions: form.sitePermissions,
              },
        )
      }
      return api.roles.create({
        slug: form.slug,
        name: form.name,
        description: form.description,
        permissions: form.permissions,
        defaultSiteRole,
        sitePermissions: form.sitePermissions,
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
      {/* Wider than the default: the matrix is three column groups of five, and a dialog that
          scrolls sideways to show them is a dialog nobody reads. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{role ? `Edit ${role.name}` : 'New role'}</DialogTitle>
            <DialogDescription>
              A role answers two questions: what its holders may do to the deployment, and what they
              may do inside a site. You can only grant deployment permissions you hold yourself.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {role?.builtin && (
              // Editing a built-in is new, and what it affects is not obvious from a dialog that
              // looks like every other one: this is not a copy, it is the role everybody already
              // holds. Nothing here can lock the deployment out — an instance owner reaches every
              // site without a role — which is why the warning is a warning and not a refusal.
              <p className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <strong>{role.name} is a built-in role.</strong> Its deployment permissions are
                fixed, but what it may do on a site is yours to change — and the change applies to
                everyone holding it, on every site, as soon as you save.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                required
                disabled={role?.builtin}
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
                disabled={role?.builtin}
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
                disabled={role?.builtin}
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
              <Label>What a holder may do on a site</Label>
              <p className="text-muted-foreground text-xs">
                MCP and API-key columns are what this role <em>delegates</em>: an agent acting as
                somebody, and a key they issue. Neither can exceed the Site column, so tick that
                first.
              </p>
              <PermissionMatrix
                value={form.sitePermissions}
                onChange={(sitePermissions) =>
                  setForm((current) => ({ ...current, sitePermissions }))
                }
              />
            </div>

            <div className="space-y-3">
              <Label>Deployment permissions</Label>
              {INSTANCE_PERMISSIONS.map((permission) => {
                const canGrant = heldPermissions.includes(permission) && !role?.builtin
                return (
                  <div key={permission} className="flex items-start justify-between gap-3 text-sm">
                    <Label htmlFor={`perm-${permission}`} className="font-normal">
                      <span className="font-mono text-xs">{permission}</span>
                      <span className="block text-muted-foreground text-xs">
                        {INSTANCE_PERMISSION_LABELS[permission]}
                        {!canGrant &&
                          (role?.builtin
                            ? ' — fixed on a built-in role'
                            : ' — you do not hold this permission')}
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
