import { DEFAULT_PREVIEW_PATH } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { type FieldRow, FieldsEditor, toFieldRows } from '@/components/fields-editor'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { ApiClientError, api } from '@/lib/api'

/** Field-schema editor. Reordering here changes the order fields appear in the entry form. */
export function CollectionSettingsPage() {
  const { collection: slug = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const siteSlug = useActiveSiteSlug()

  const collection = useQuery({
    queryKey: ['collection', siteSlug, slug],
    queryFn: () => api.collections.get(slug),
  })

  const [rows, setRows] = useState<FieldRow[]>([])
  const [name, setName] = useState('')
  const [previewPath, setPreviewPath] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})

  useEffect(() => {
    if (collection.data) {
      setRows(toFieldRows(collection.data.fields))
      setName(collection.data.name)
      setPreviewPath(collection.data.previewPath ?? '')
    }
  }, [collection.data])

  const save = useMutation({
    mutationFn: () =>
      api.collections.update(slug, {
        name,
        fields: rows.map((row) => row.field),
        // Blank falls back to the default shape rather than storing an empty template.
        previewPath: previewPath.trim() || null,
      }),
    onSuccess: () => {
      setFieldErrors({})
      queryClient.invalidateQueries({ queryKey: ['collection', slug] })
      queryClient.invalidateQueries({ queryKey: ['collections'] })
      toast.success('Collection updated')
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.details) setFieldErrors(error.details)
      toast.error(error.message)
    },
  })

  const remove = useMutation({
    mutationFn: () => api.collections.remove(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] })
      toast.success('Collection deleted')
      navigate('/collections')
    },
  })

  if (collection.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title={`${collection.data?.name ?? slug} fields`}
        description="Define the shape of entries in this collection."
        actions={
          <>
            <Button variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Delete collection
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save changes
            </Button>
          </>
        }
      />

      <div className="max-w-3xl space-y-6 p-8">
        <div className="space-y-2">
          <Label htmlFor="collection-name">Collection name</Label>
          <Input
            id="collection-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="collection-preview-path">Preview path</Label>
          <Input
            id="collection-preview-path"
            className="font-mono"
            placeholder={DEFAULT_PREVIEW_PATH}
            value={previewPath}
            onChange={(event) => setPreviewPath(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Appended to the site's preview URL to reach one entry. <code>{'{collection}'}</code>,{' '}
            <code>{'{slug}'}</code> and <code>{'{locale}'}</code> are filled in. Blank uses{' '}
            <code>{DEFAULT_PREVIEW_PATH}</code>.
          </p>
          {fieldErrors.previewPath && (
            <p className="text-destructive text-xs">{fieldErrors.previewPath.join(', ')}</p>
          )}
        </div>

        <FieldsEditor rows={rows} onChange={setRows} />
      </div>
    </>
  )
}
