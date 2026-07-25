import { FIELD_KINDS, type Field, type FieldKind } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'

interface Row {
  key: string
  field: Field
}

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

  // Rows carry a stable key so React keeps input focus and state across reorders and renames —
  // the field's own name is user-editable and therefore unusable as a key.
  const [rows, setRows] = useState<Row[]>([])
  const [name, setName] = useState('')
  const nextKey = useRef(0)

  useEffect(() => {
    if (collection.data) {
      setRows(collection.data.fields.map((field) => ({ key: `field-${nextKey.current++}`, field })))
      setName(collection.data.name)
    }
  }, [collection.data])

  const save = useMutation({
    mutationFn: () => api.collections.update(slug, { name, fields: rows.map((row) => row.field) }),
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

  function updateField(index: number, patch: Partial<Field>) {
    setRows((current) =>
      current.map((row, i) =>
        i === index ? { ...row, field: { ...row.field, ...patch } as Field } : row,
      ),
    )
  }

  function move(index: number, delta: number) {
    setRows((current) => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved!)
      return next
    })
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

        <div className="space-y-3">
          {rows.map(({ key, field }, index) => (
            <Card key={key}>
              <CardContent className="space-y-4 pt-6">
                <div className="flex items-start gap-3">
                  <div className="flex flex-col pt-2">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Move field up"
                      onClick={() => move(index, -1)}
                    >
                      <GripVertical className="size-4" />
                    </button>
                  </div>

                  <div className="grid flex-1 gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Label</Label>
                      <Input
                        value={field.label}
                        onChange={(event) => updateField(index, { label: event.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">API name</Label>
                      <Input
                        value={field.name}
                        onChange={(event) =>
                          updateField(index, {
                            name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Type</Label>
                      <Select
                        value={field.kind}
                        onValueChange={(value) =>
                          setRows((current) =>
                            current.map((row, i) =>
                              i === index
                                ? { ...row, field: blankField(value as FieldKind, row.field) }
                                : row,
                            ),
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FIELD_KINDS.map((kind) => (
                            <SelectItem key={kind} value={kind} className="capitalize">
                              {kind}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove field"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                <div className="flex items-center gap-6 pl-7">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`${key}-required`}
                      checked={field.required}
                      onCheckedChange={(checked) => updateField(index, { required: checked })}
                    />
                    <Label htmlFor={`${key}-required`} className="text-sm font-normal">
                      Required
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`${key}-localized`}
                      checked={field.localized}
                      onCheckedChange={(checked) => updateField(index, { localized: checked })}
                    />
                    <Label htmlFor={`${key}-localized`} className="text-sm font-normal">
                      Localized
                    </Label>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Button
          variant="outline"
          onClick={() =>
            setRows((current) => [
              ...current,
              {
                key: `field-${nextKey.current++}`,
                field: blankField('text', {
                  name: `field_${current.length + 1}`,
                  label: `Field ${current.length + 1}`,
                }),
              },
            ])
          }
        >
          <Plus className="size-4" />
          Add field
        </Button>
      </div>
    </>
  )
}

/** Builds a field of the requested kind, carrying over the name/label/flags that all kinds share. */
function blankField(
  kind: FieldKind,
  base: { name: string; label: string; required?: boolean; localized?: boolean },
): Field {
  const shared = {
    name: base.name,
    label: base.label,
    required: base.required ?? false,
    localized: base.localized ?? false,
  }

  switch (kind) {
    case 'text':
      return { ...shared, kind, multiline: false }
    case 'richtext':
      return { ...shared, kind, format: 'markdown' }
    case 'number':
      return { ...shared, kind, integer: false }
    case 'boolean':
      return { ...shared, kind }
    case 'date':
      return { ...shared, kind, includeTime: true }
    case 'select':
      return { ...shared, kind, options: [{ value: 'option', label: 'Option' }], multiple: false }
    case 'media':
      return { ...shared, kind, accept: [], multiple: false }
    case 'reference':
      return { ...shared, kind, collection: '', multiple: false }
    case 'json':
      return { ...shared, kind }
  }
}
