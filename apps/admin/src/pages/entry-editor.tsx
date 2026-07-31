import type { EntryMetadata, EntryStatus, EntryVisibility } from '@hedge/core'
import { localeLabel, slugify } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EntryPreview } from '@/components/entry-preview'
import { EntryRevisions } from '@/components/entry-revisions'
import { EntryVersions } from '@/components/entry-versions'
import { FieldInput } from '@/components/field-input'
import { PageHeader } from '@/components/page-header'
import { SocialImageInput } from '@/components/social-image-input'
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
import { useSession } from '@/hooks/use-session'
import { useActiveSite, useActiveSiteSlug } from '@/hooks/use-site'
import { ApiClientError, api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'

const EMPTY_METADATA: EntryMetadata = { noIndex: false, custom: {} }

export function EntryEditorPage() {
  const { collection: collectionSlug = '', slug } = useParams()
  const t = useT()
  const { formatDateTime } = useFormatters()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isNew = !slug

  const siteSlug = useActiveSiteSlug()
  const { site } = useActiveSite()
  // Who is editing — the versions panel needs it to know whose work it may not review.
  const session = useSession()
  const locales = site?.locales ?? []
  const customFields = site?.customFields ?? []
  // The locale being edited: the URL wins, then the site's default, then a safe fallback.
  const locale = params.get('locale') ?? site?.defaultLocale ?? 'en'

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

  // A creatable or multiple select converges on a shared vocabulary if the editor suggests values
  // already used elsewhere in the collection. Only fetched when such a field exists.
  const collectionFields = collection.data?.fields ?? []
  const needsSuggestions = collectionFields.some(
    (field) => field.kind === 'select' && (field.creatable || field.multiple),
  )
  const suggestionSource = useQuery({
    queryKey: ['field-suggestions', siteSlug, collectionSlug],
    queryFn: () => api.entries.list(collectionSlug, { limit: 100 }),
    enabled: Boolean(siteSlug) && needsSuggestions,
  })
  const suggestions = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const field of collection.data?.fields ?? []) {
      if (field.kind !== 'select') continue
      const seen = new Set<string>()
      for (const item of suggestionSource.data?.data ?? []) {
        const raw = item.data[field.name]
        if (Array.isArray(raw)) {
          for (const one of raw) if (typeof one === 'string' && one) seen.add(one)
        } else if (typeof raw === 'string' && raw) {
          seen.add(raw)
        }
      }
      map[field.name] = [...seen]
    }
    return map
  }, [collection.data?.fields, suggestionSource.data])

  // Following a link to an existing slug in a locale that has no translation yet 404s. That is not
  // an error to the editor — it is the empty canvas for creating that translation, sharing the slug.
  const translationMissing =
    !isNew && entry.isError && entry.error instanceof ApiClientError && entry.error.status === 404
  const creating = isNew || translationMissing

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
    } else if (translationMissing) {
      // Seed a blank translation that keeps the slug, so the new locale sits beside the others.
      setData({})
      setMetadata(EMPTY_METADATA)
      setEntrySlug(slug ?? '')
      setStatus('draft')
      setVisibility('public')
    }
  }, [entry.data, translationMissing, slug])

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
      return creating
        ? api.entries.create(collectionSlug, { ...payload, locale })
        : api.entries.update(collectionSlug, slug!, payload, locale)
    },
    onSuccess: (saved) => {
      setFieldErrors({})
      queryClient.invalidateQueries({ queryKey: ['entries', collectionSlug] })
      queryClient.invalidateQueries({ queryKey: ['entry', collectionSlug] })
      toast.success(t('common.saved'))
      if (creating) {
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
      toast.success(t('editor.entryDeleted'))
      navigate(`/collections/${collectionSlug}`)
    },
  })

  /** Switch which locale variant is being edited, keeping the slug (or the new-entry route). */
  function switchLocale(next: string) {
    const base = slug
      ? `/collections/${collectionSlug}/entries/${slug}`
      : `/collections/${collectionSlug}/entries/new`
    navigate(`${base}?locale=${next}`)
  }

  if (collection.isLoading || (!isNew && entry.isLoading)) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  const fields = collection.data?.fields ?? []
  const approvalLevels = collection.data?.approvalLevels ?? 0
  const title = String(data.title ?? '') || (creating ? t('editor.newEntry') : entrySlug)

  return (
    <>
      <PageHeader
        title={title}
        description={`${collection.data?.name ?? collectionSlug} · ${localeLabel(locale)}`}
        actions={
          <>
            <Button variant="ghost" size="icon" asChild aria-label={t('common.back')}>
              <Link to={`/collections/${collectionSlug}`}>
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            {/* Preview renders what is *saved*, so it only makes sense once the entry exists. */}
            {!creating && (
              <EntryPreview
                collection={collectionSlug}
                slug={entry.data?.slug ?? slug!}
                locale={locale}
                disabled={save.isPending}
              />
            )}
            {!creating && (
              <Button
                variant="outline"
                size="icon"
                aria-label={t('editor.deleteEntry')}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
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
              locale={locale}
              suggestions={suggestions[field.name]}
              error={fieldErrors[field.name]?.join(', ')}
              onChange={(value) => setData((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
          {fields.length === 0 && (
            <p className="text-muted-foreground text-sm">
              {t('editor.noFields')}{' '}
              <Link className="underline" to={`/collections/${collectionSlug}/settings`}>
                {t('editor.addFields')}
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
              <SocialImageInput
                id="meta-og"
                value={metadata.ogImage}
                onChange={(ogImage) => patchMetadata({ ogImage })}
              />
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
          {/* Only a multilingual site has variants to move between. */}
          {locales.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="locale">{t('editor.locale')}</Label>
              <Select value={locale} onValueChange={switchLocale}>
                <SelectTrigger id="locale">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((code) => (
                    <SelectItem key={code} value={code}>
                      {localeLabel(code)} · {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {translationMissing
                  ? t('editor.translationMissing', { locale: localeLabel(locale) })
                  : t('editor.localeHint')}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="status">{t('editor.status')}</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as EntryStatus)}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">{t('entries.statusDraft')}</SelectItem>
                {/* With approvals on, publishing is a step rather than a field: the server refuses
                    this transition, so offering it here would only produce a 409. Already-published
                    entries keep the option, since staying published is not a new publish. */}
                {(approvalLevels === 0 || status === 'published') && (
                  <SelectItem value="published">{t('entries.statusPublished')}</SelectItem>
                )}
                <SelectItem value="archived">{t('entries.statusArchived')}</SelectItem>
              </SelectContent>
            </Select>
            {approvalLevels > 0 && status !== 'published' && (
              <p className="text-muted-foreground text-xs">
                {t('editor.approvalNotice', { levels: approvalLevels })}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="visibility">{t('editor.visibility')}</Label>
            <Select
              value={visibility}
              onValueChange={(value) => setVisibility(value as EntryVisibility)}
            >
              <SelectTrigger id="visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">{t('editor.visPublic')}</SelectItem>
                <SelectItem value="members">{t('editor.visMembers')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {visibility === 'members' ? t('editor.visMembersHint') : t('editor.visPublicHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">{t('editor.slug')}</Label>
            <Input
              id="slug"
              value={entrySlug}
              placeholder={slugify(String(data.title ?? '')) || t('editor.slugAuto')}
              onChange={(event) => setEntrySlug(slugify(event.target.value))}
            />
            {fieldErrors.slug && (
              <p className="text-destructive text-xs">{fieldErrors.slug.join(', ')}</p>
            )}
          </div>

          {entry.data && (
            <dl className="space-y-1 border-t pt-4 text-muted-foreground text-xs">
              <div className="flex justify-between gap-2">
                <dt>{t('editor.created')}</dt>
                <dd>{formatDateTime(entry.data.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>{t('editor.updated')}</dt>
                <dd>{formatDateTime(entry.data.updatedAt)}</dd>
              </div>
              {entry.data.publishedAt && (
                <div className="flex justify-between gap-2">
                  <dt>{t('editor.published')}</dt>
                  <dd>{formatDateTime(entry.data.publishedAt)}</dd>
                </div>
              )}
            </dl>
          )}

          {/* What this entry may become, and what it was. Both read the live form state as "the
              entry", so a comparison includes unsaved edits. A new entry has neither yet: versions
              hang off an entry that exists, so the first save still creates the draft row. */}
          {entry.data && !creating && session.data && (
            <EntryVersions
              collection={collectionSlug}
              slug={entry.data.slug}
              locale={locale}
              currentData={data}
              currentUserId={session.data.id}
            />
          )}

          {entry.data && !creating && (
            <EntryRevisions
              collection={collectionSlug}
              slug={entry.data.slug}
              locale={locale}
              currentData={data}
            />
          )}
        </aside>
      </div>
    </>
  )
}
