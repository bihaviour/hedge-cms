import { type Site, slugify } from '@hedge/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Globe, Plus, Trash2 } from 'lucide-react'
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
import { useActiveSite, useSwitchSite } from '@/hooks/use-site'
import { api } from '@/lib/api'

/** One deployment, many websites. Each row here is an independent content namespace. */
export function SitesPage() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const { site: active, sites, isLoading } = useActiveSite()
  const switchSite = useSwitchSite()

  const remove = useMutation({
    mutationFn: api.sites.remove,
    onSuccess: () => {
      queryClient.invalidateQueries()
      toast.success('Site deleted')
    },
    onError: (error) => toast.error(error.message),
  })

  const toggleSignup = useMutation({
    mutationFn: ({ slug, allowMemberSignup }: { slug: string; allowMemberSignup: boolean }) =>
      api.sites.update(slug, { allowMemberSignup }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sites'] }),
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title="Sites"
        description="Every site is its own content namespace — collections, media, keys and members."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            New site
          </Button>
        }
      />

      <div className="p-8">
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-40">Slug</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="w-36">Member signup</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((site) => (
                  <SiteRow
                    key={site.id}
                    site={site}
                    isActive={site.slug === active?.slug}
                    canDelete={sites.length > 1}
                    onSwitch={() => switchSite(site.slug)}
                    onToggleSignup={(allowMemberSignup) =>
                      toggleSignup.mutate({ slug: site.slug, allowMemberSignup })
                    }
                    onDelete={() => remove.mutate(site.slug)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <NewSiteDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function SiteRow({
  site,
  isActive,
  canDelete,
  onSwitch,
  onToggleSignup,
  onDelete,
}: {
  site: Site
  isActive: boolean
  canDelete: boolean
  onSwitch: () => void
  onToggleSignup: (allow: boolean) => void
  onDelete: () => void
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        {site.name}
        {isActive && (
          <Badge variant="secondary" className="ml-2">
            <Check className="size-3" />
            Current
          </Badge>
        )}
        {site.description && <p className="text-muted-foreground text-xs">{site.description}</p>}
      </TableCell>
      <TableCell className="font-mono text-muted-foreground text-xs">{site.slug}</TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {site.domain ? (
          <span className="inline-flex items-center gap-1.5">
            <Globe className="size-3.5" />
            {site.domain}
          </span>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={site.allowMemberSignup}
          aria-label={`Allow member signup on ${site.name}`}
          onCheckedChange={onToggleSignup}
        />
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          {!isActive && (
            <Button variant="outline" size="sm" onClick={onSwitch}>
              Switch
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${site.name}`}
              onClick={() => {
                if (
                  confirm(`Delete "${site.name}"? Its collections, entries and members go too.`)
                ) {
                  onDelete()
                }
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function NewSiteDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', slug: '', domain: '' })

  const create = useMutation({
    mutationFn: api.sites.create,
    onSuccess: (site) => {
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success(`Created "${site.name}"`)
      onOpenChange(false)
      setForm({ name: '', slug: '', domain: '' })
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
              slug: form.slug || slugify(form.name),
              domain: form.domain || null,
              allowMemberSignup: true,
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>New site</DialogTitle>
            <DialogDescription>
              A blog, a documentation site, a landing page — each keeps its own content.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                required
                placeholder="Documentation"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-slug">Slug</Label>
              <Input
                id="site-slug"
                value={form.slug}
                placeholder={slugify(form.name) || 'documentation'}
                onChange={(event) => setForm({ ...form, slug: slugify(event.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                Sent as the <code>X-Hedge-Site</code> header to pick this site.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-domain">Domain (optional)</Label>
              <Input
                id="site-domain"
                placeholder="docs.example.com"
                value={form.domain}
                onChange={(event) => setForm({ ...form, domain: event.target.value.trim() })}
              />
              <p className="text-muted-foreground text-xs">
                Requests arriving on this hostname resolve to this site automatically.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !form.name}>
              Create site
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
