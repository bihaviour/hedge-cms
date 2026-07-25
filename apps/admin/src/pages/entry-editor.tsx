import type { EntryMetadata, EntryStatus, EntryVisibility } from '@hedge/core'
import { slugify } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { FieldInput } from '@/components/field-input'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useActiveSite, useActiveSiteSlug } from '@/hooks/use-site'
import { ApiClientError, api } from '@/lib/api'

const EMPTY_METADATA: EntryMetadata = { noIndex: false, custom: {} }

export function EntryEditorPage() {
  const { collection: collectionSlug = '', slug } = useParams()
  const [params] = useSearchParams()
  const locale = params.get('locale') ?? 'en'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isNew = !slug

  const siteSlug = useActiveSiteSlug()
  const { site } = useActiveSite()
  const customFields = site?.customFields ?? []

  const collection = useQuery({
    queryKey: ['collection', siteSlug, collectionSlug],
    queryFn: () => api.collections.get(collectionSlug),
    enabled: Boolean(siteSlug),
  })

  const entry = useQuery({
    queryKey: ['entry', siteSlug, collectionSlug, slug, locale],
    queryFn: () => api.entries.get(collectionSlug, slug!, locale),
    enabled: !isNew && Boolean(siteSlug),
  })

  const [data, setData] = useState<Record<string, unknown>>({})
  const [metadata, setMetadata] = useState<EntryMetadata>(EMPTY_METADATA)
  const [entrySlug, setEntrySlug] = useState('')
  const [status, setStatus] = useState<EntryStatus>('draft')
  const [visibility, setVisibility] = useState<EntryVisibility>('public')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})

  useEffect(() => {
    if (entry.data) {
      setData(entry.data.data)
      setMetadata({ ...EMPTY_METADATA, ...entry.data.metadata })
      setEntrySlug(entry.data.slug)
      setStatus(entry.data.status)
      setVisibility(entry.data.visibility)
    }
  }, [entry.data])

  function patchMetadata(patch: Partial<EntryMetadata>) {
    setMetadata((current) => ({ ...current, ...patch }))
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        data,
        metadata,
        status,
        visibility,
        ...(entrySlug ? { slug: entrySlug } : {}),
      }
      return isNew
        ? api.entries.create(collectionSlug, { ...payload, locale })
        : api.entries.update(collectionSlug, slug!, payload, locale)
    },
    onSuccess: (saved) => {
      setFieldErrors({})
      queryClient.invalidateQueries({ queryKey: ['entries', collectionSlug] })
      queryClient.invalidateQueries({ queryKey: ['entry', collectionSlug] })
      toast.success('Saved')
      if (isNew) {
        navigate(`/collections/${collectionSlug}/entries/${saved.slug}?locale=${saved.locale}`, {
          replace: true,
        })
      }
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.details) setFieldErrors(error.details)
      toast.error(error.message)
    },
  })

  const remove = useMutation({
    mutationFn: () => api.entries.remove(collectionSlug, slug!, locale),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entries', collectionSlug] })
      toast.success('Entry deleted')
      navigate(`/collections/${collectionSlug}`)
    },
  })

  if (collection.isLoading || (!isNew && entry.isLoading)) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  const fields = collection.data?.fields ?? []
  const title = String(data.title ?? '') || (isNew ? 'New entry' : entrySlug)

  return (
    <>
      <PageHeader
        title={title}
        description={`${collection.data?.name ?? collectionSlug} · ${locale}`}
        actions={
          <>
            <Button variant="ghost" size="icon" asChild aria-label="Back">
              <Link to={`/collections/${collectionSlug}`}>
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            {!isNew && (
              <Button
                variant="outline"
                size="icon"
                aria-label="Delete entry"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
          </>
        }
      />

      <div className="grid gap-8 p-8 lg:grid-cols-[1fr_280px]">
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          {fields.map((field) => (
            <FieldInput
              key={field.name}
              field={field}
              value={data[field.name]}
              error={fieldErrors[field.name]?.join(', ')}
              onChange={(value) => setData((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
          {fields.length === 0 && (
            <p className="text-muted-foreground text-sm">
              This collection has no fields yet.{' '}
              <Link className="underline" to={`/collections/${collectionSlug}/settings`}>
                Add some
              </Link>
              .
            </p>
          )}

          <section className="space-y-5 border-t pt-6">
            <div>
              <h2 className="font-medium">Metadata &amp; SEO</h2>
              <p className="text-muted-foreground text-sm">
                Overrides this site's defaults for this entry. Blank fields fall back to the site
                settings.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="meta-title">Meta title</Label>
              <Input
                id="meta-title"
                value={metadata.metaTitle ?? ''}
                onChange={(event) => patchMetadata({ metaTitle: event.target.value || undefined })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="meta-description">Meta description</Label>
              <Textarea
                id="meta-description"
                rows={2}
                value={metadata.description ?? ''}
                onChange={(event) =>
                  patchMetadata({ description: event.target.value || undefined })
                }
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="meta-canonical">Canonical URL</Label>
                <Input
                  id="meta-canonical"
                  type="url"
                  placeholder="https://example.com/page"
                  value={metadata.canonicalUrl ?? ''}
                  onChange={(event) =>
                    patchMetadata({ canonicalUrl: event.target.value || undefined })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="meta-og">Social image</Label>
                <Input
                  id="meta-og"
                  placeholder="Media key or URL"
                  value={metadata.ogImage ?? ''}
                  onChange={(event) => patchMetadata({ ogImage: event.target.value || undefined })}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="meta-noindex"
                checked={metadata.noIndex}
                onCheckedChange={(checked) => patchMetadata({ noIndex: checked })}
              />
              <Label htmlFor="meta-noindex" className="font-normal text-sm">
                Ask search engines not to index this entry
              </Label>
            </div>

            {customFields.length > 0 && (
              <div className="space-y-5 border-t pt-5">
                <p className="text-muted-foreground text-sm">Custom fields for this site</p>
                {customFields.map((field) => (
                  <FieldInput
                    key={field.name}
                    field={field}
                    value={metadata.custom[field.name]}
                    error={fieldErrors[`metadata.${field.name}`]?.join(', ')}
                    onChange={(value) =>
                      patchMetadata({ custom: { ...metadata.custom, [field.name]: value } })
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </form>

        <aside className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as EntryStatus)}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="visibility">Visibility</Label>
            <Select
              value={visibility}
              onValueChange={(value) => setVisibility(value as EntryVisibility)}
            >
              <SelectTrigger id="visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="members">Members only</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {visibility === 'members'
                ? 'The delivery API returns this entry without its content until a member signs in.'
                : 'Anyone with a delivery API key can read this entry once published.'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">Slug</Label>
            <Input
              id="slug"
              value={entrySlug}
              placeholder={slugify(String(data.title ?? '')) || 'auto-generated'}
              onChange={(event) => setEntrySlug(slugify(event.target.value))}
            />
            {fieldErrors.slug && (
              <p className="text-destructive text-xs">{fieldErrors.slug.join(', ')}</p>
            )}
          </div>

          {entry.data && (
            <dl className="space-y-1 border-t pt-4 text-muted-foreground text-xs">
              <div className="flex justify-between gap-2">
                <dt>Created</dt>
                <dd>{new Date(entry.data.createdAt).toLocaleString()}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Updated</dt>
                <dd>{new Date(entry.data.updatedAt).toLocaleString()}</dd>
              </div>
              {entry.data.publishedAt && (
                <div className="flex justify-between gap-2">
                  <dt>Published</dt>
                  <dd>{new Date(entry.data.publishedAt).toLocaleString()}</dd>
                </div>
              )}
            </dl>
          )}
        </aside>
      </div>
    </>
  )
}
