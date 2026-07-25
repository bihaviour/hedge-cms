import { slugify } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { api } from '@/lib/api'

export function CollectionsPage() {
  const [open, setOpen] = useState(false)
  const collections = useQuery({ queryKey: ['collections'], queryFn: api.collections.list })

  return (
    <>
      <PageHeader
        title="Collections"
        description="Content types available in this workspace."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            New collection
          </Button>
        }
      />

      <div className="p-8">
        {collections.isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-32" />
            ))}
          </div>
        )}

        {collections.data?.length === 0 && (
          <EmptyState
            title="No collections yet"
            description="A collection defines the shape of a content type — posts, pages, authors, anything."
            action={<Button onClick={() => setOpen(true)}>Create your first collection</Button>}
          />
        )}

        {collections.data && collections.data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.data.map((collection) => (
              <Link key={collection.id} to={`/collections/${collection.slug}`}>
                <Card className="h-full transition-colors hover:border-foreground/20">
                  <CardHeader>
                    <CardTitle className="text-base">{collection.name}</CardTitle>
                    <CardDescription>
                      {collection.description || `/${collection.slug}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="text-muted-foreground text-sm">
                    {collection.fields.length} field{collection.fields.length === 1 ? '' : 's'} ·{' '}
                    {collection.kind === 'single' ? 'single entry' : 'multiple entries'}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <NewCollectionDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function NewCollectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [kind, setKind] = useState<'multiple' | 'single'>('multiple')

  const create = useMutation({
    mutationFn: api.collections.create,
    onSuccess: (collection) => {
      queryClient.invalidateQueries({ queryKey: ['collections'] })
      toast.success(`Created "${collection.name}"`)
      onOpenChange(false)
      setName('')
      setSlug('')
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate({ name, slug: slug || slugify(name), kind })
          }}
        >
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>
              You can add and edit fields once the collection exists.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={name}
                placeholder="Blog posts"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">API slug</Label>
              <Input
                id="slug"
                value={slug}
                placeholder={slugify(name) || 'blog-posts'}
                onChange={(event) => setSlug(slugify(event.target.value))}
              />
              <p className="text-muted-foreground text-xs">
                Used in URLs: <code>/api/v1/content/{slug || slugify(name) || 'blog-posts'}</code>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="kind">Type</Label>
              <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="multiple">Multiple entries</SelectItem>
                  <SelectItem value="single">Single entry (settings, landing page)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {create.error && (
              <p className="text-destructive text-sm">{(create.error as Error).message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
