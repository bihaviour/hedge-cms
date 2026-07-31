import type { ApprovalLevels } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { type FieldRow, FieldsEditor, toFieldRows } from '@/components/fields-editor'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
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
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'

/** Field-schema editor. Reordering here changes the order fields appear in the entry form. */
export function CollectionSettingsPage() {
  const { collection: slug = '' } = useParams()
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const siteSlug = useActiveSiteSlug()

  const collection = useQuery({
    queryKey: ['collection', siteSlug, slug],
    queryFn: () => api.collections.get(slug),
  })

  const [rows, setRows] = useState<FieldRow[]>([])
  const [name, setName] = useState('')
  const [approvalLevels, setApprovalLevels] = useState<ApprovalLevels>(0)

  useEffect(() => {
    if (collection.data) {
      setRows(toFieldRows(collection.data.fields))
      setName(collection.data.name)
      setApprovalLevels(collection.data.approvalLevels)
    }
  }, [collection.data])

  const save = useMutation({
    mutationFn: () =>
      api.collections.update(slug, {
        name,
        approvalLevels,
        fields: rows.map((row) => row.field),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', slug] })
      queryClient.invalidateQueries({ queryKey: ['collections'] })
      toast.success('Collection updated')
    },
    onError: (error) => toast.error(error.message),
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

        {/* Switching this on changes what publishing *is* for this collection, so the copy says so
            plainly rather than describing it as a preference. */}
        <div className="space-y-2 border-t pt-6">
          <h2 className="font-medium">{t('collections.approvalTitle')}</h2>
          <Label htmlFor="collection-approvals">{t('collections.approvalLabel')}</Label>
          <Select
            value={String(approvalLevels)}
            onValueChange={(value) => setApprovalLevels(Number(value) as ApprovalLevels)}
          >
            <SelectTrigger id="collection-approvals">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t('collections.approvalOff')}</SelectItem>
              <SelectItem value="1">{t('collections.approvalOne')}</SelectItem>
              <SelectItem value="2">{t('collections.approvalTwo')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t('collections.approvalHint')}</p>
        </div>

        <div className="border-t pt-6">
          <FieldsEditor rows={rows} onChange={setRows} />
        </div>
      </div>
    </>
  )
}
