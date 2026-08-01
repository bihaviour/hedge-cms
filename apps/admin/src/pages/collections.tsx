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
import { useActiveSiteSlug, useHasSiteRole } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'

export function CollectionsPage() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const siteSlug = useActiveSiteSlug()
  // Creating one is `requireSiteRole('admin')`, like reshaping and deleting one — see
  // collection-settings.tsx. An editor sees the collections and none of the model-editing controls.
  const canManage = useHasSiteRole('admin')
  const collections = useQuery({
    queryKey: ['collections', siteSlug],
    queryFn: api.collections.list,
    enabled: Boolean(siteSlug),
  })

  return (
    <>
      <PageHeader
        title={t('collections.title')}
        description={t('collections.subtitle')}
        actions={
          canManage && (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" />
              {t('collections.new')}
            </Button>
          )
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
            title={t('collections.emptyTitle')}
            description={t('collections.emptyDescription')}
            action={
              canManage && (
                <Button onClick={() => setOpen(true)}>{t('collections.emptyAction')}</Button>
              )
            }
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
                    {t(
                      collection.kind === 'single'
                        ? 'collections.metaSingle'
                        : 'collections.metaMultiple',
                      { count: collection.fields.length },
                    )}
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
  const t = useT()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [kind, setKind] = useState<'multiple' | 'single'>('multiple')

  const create = useMutation({
    mutationFn: api.collections.create,
    onSuccess: (collection) => {
      queryClient.invalidateQueries({ queryKey: ['collections'] })
      toast.success(t('common.created', { name: collection.name }))
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
            <DialogTitle>{t('collections.newTitle')}</DialogTitle>
            <DialogDescription>{t('collections.newDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('collections.name')}</Label>
              <Input
                id="name"
                required
                value={name}
                placeholder="Blog posts"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">{t('collections.apiSlug')}</Label>
              <Input
                id="slug"
                value={slug}
                placeholder={slugify(name) || 'blog-posts'}
                onChange={(event) => setSlug(slugify(event.target.value))}
              />
              <p className="text-muted-foreground text-xs">
                <code>/api/v1/content/{slug || slugify(name) || 'blog-posts'}</code>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="kind">{t('collections.type')}</Label>
              <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="multiple">{t('collections.typeMultiple')}</SelectItem>
                  <SelectItem value="single">{t('collections.typeSingle')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {create.error && (
              <p className="text-destructive text-sm">{(create.error as Error).message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !name}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
