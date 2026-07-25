import type { MetaEntry, SiteMetadata } from '@hedge/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type FieldRow, FieldsEditor, toFieldRows } from '@/components/fields-editor'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useActiveSite } from '@/hooks/use-site'
import { ApiClientError, api } from '@/lib/api'

const EMPTY_META: SiteMetadata = { keywords: [], custom: [] }

/**
 * Per-site metadata defaults and custom fields — everything here is unique to the active site. The
 * metadata block is the SEO/social defaults every entry inherits; the custom fields are extra,
 * site-wide fields that appear on every entry's metadata panel.
 */
export function SiteSettingsPage() {
  const queryClient = useQueryClient()
  const { site, isLoading } = useActiveSite()

  const [meta, setMeta] = useState<SiteMetadata>(EMPTY_META)
  const [rows, setRows] = useState<FieldRow[]>([])
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})

  // Reseed whenever the active site changes — the form is per-site.
  useEffect(() => {
    if (site) {
      setMeta({ ...EMPTY_META, ...site.metadata })
      setRows(toFieldRows(site.customFields))
    }
  }, [site])

  const save = useMutation({
    mutationFn: () =>
      api.sites.updateConfig(site!.slug, {
        metadata: meta,
        customFields: rows.map((row) => row.field),
      }),
    onSuccess: () => {
      setFieldErrors({})
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success('Site settings saved')
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.details) setFieldErrors(error.details)
      toast.error(error.message)
    },
  })

  if (isLoading || !site) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  function patchMeta(patch: Partial<SiteMetadata>) {
    setMeta((current) => ({ ...current, ...patch }))
  }

  return (
    <>
      <PageHeader
        title="Site settings"
        description={`Metadata defaults and custom fields for "${site.name}".`}
        actions={
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save changes
          </Button>
        }
      />

      <div className="max-w-3xl space-y-10 p-8">
        <section className="space-y-5">
          <div>
            <h2 className="font-medium text-lg">Metadata defaults</h2>
            <p className="text-muted-foreground text-sm">
              Inherited by every entry on this site unless the entry overrides them.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="meta-title">Default title</Label>
              <Input
                id="meta-title"
                value={meta.metaTitle ?? ''}
                onChange={(event) => patchMeta({ metaTitle: event.target.value || undefined })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="meta-template">Title template</Label>
              <Input
                id="meta-template"
                placeholder="%s · My Site"
                value={meta.titleTemplate ?? ''}
                onChange={(event) => patchMeta({ titleTemplate: event.target.value || undefined })}
              />
              <p className="text-muted-foreground text-xs">
                <code>%s</code> is replaced with the entry's title.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-description">Default description</Label>
            <Textarea
              id="meta-description"
              rows={2}
              value={meta.description ?? ''}
              onChange={(event) => patchMeta({ description: event.target.value || undefined })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="meta-og">Social image</Label>
              <Input
                id="meta-og"
                placeholder="Media key or URL"
                value={meta.ogImage ?? ''}
                onChange={(event) => patchMeta({ ogImage: event.target.value || undefined })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="meta-twitter">Twitter handle</Label>
              <Input
                id="meta-twitter"
                placeholder="@handle"
                value={meta.twitterHandle ?? ''}
                onChange={(event) => patchMeta({ twitterHandle: event.target.value || undefined })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-keywords">Keywords</Label>
            <Input
              id="meta-keywords"
              placeholder="comma, separated, keywords"
              value={meta.keywords.join(', ')}
              onChange={(event) =>
                patchMeta({
                  keywords: event.target.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>

          <CustomPairs pairs={meta.custom} onChange={(custom) => patchMeta({ custom })} />
        </section>

        <section className="space-y-5">
          <div>
            <h2 className="font-medium text-lg">Custom fields</h2>
            <p className="text-muted-foreground text-sm">
              Extra fields shown on every entry's metadata panel, on top of its collection's own
              fields.
            </p>
          </div>

          <FieldsEditor rows={rows} onChange={setRows} addLabel="Add custom field" />

          {Object.entries(fieldErrors).length > 0 && (
            <ul className="space-y-1 text-destructive text-xs">
              {Object.entries(fieldErrors).map(([key, messages]) => (
                <li key={key}>
                  <span className="font-mono">{key}</span>: {messages.join(', ')}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}

/** The free-form key/value metadata pairs — an escape hatch for whatever has no dedicated field. */
function CustomPairs({
  pairs,
  onChange,
}: {
  pairs: MetaEntry[]
  onChange: (pairs: MetaEntry[]) => void
}) {
  return (
    <div className="space-y-2">
      <Label>Custom metadata</Label>
      <div className="space-y-2">
        {pairs.map((pair, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: pairs have no stable id and reorder only on delete
          <div key={index} className="flex gap-2">
            <Input
              className="font-mono"
              placeholder="key"
              value={pair.key}
              onChange={(event) =>
                onChange(pairs.map((p, i) => (i === index ? { ...p, key: event.target.value } : p)))
              }
            />
            <Input
              placeholder="value"
              value={pair.value}
              onChange={(event) =>
                onChange(
                  pairs.map((p, i) => (i === index ? { ...p, value: event.target.value } : p)),
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove metadata pair"
              onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
      >
        <Plus className="size-4" />
        Add pair
      </Button>
    </div>
  )
}
