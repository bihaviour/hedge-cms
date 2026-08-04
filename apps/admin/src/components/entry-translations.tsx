import type { EntryTranslation } from '@hedge/core'
import { localeLabel } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Unlink } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'

/**
 * The languages one post is written in, and the two operations that change which post a row belongs
 * to.
 *
 * This is the admin side of "several posts are really one piece in several languages". Before
 * translations could be linked, the only way to say two rows were the same piece was to give them
 * the same slug — so anyone who wanted a URL in each language had to author genuinely separate
 * posts. Linking is the repair for those, and it stays a deliberate act by a person: only someone
 * who can read both can tell whether they are the same piece.
 *
 * Nothing here edits content. A link changes no text, no status and no URL, which is what makes it
 * safe to offer beside the editor rather than behind a confirmation.
 */
export function EntryTranslations({
  collection,
  slug,
  locale,
  siteLocales,
}: {
  collection: string
  slug: string
  locale: string
  siteLocales: string[]
}) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const siteSlug = useActiveSiteSlug()
  const [pick, setPick] = useState('')

  // Keyed on the slug, not the locale: a post's languages are the same set whichever of them you
  // are looking at, so switching locale should not refetch.
  const translations = useQuery({
    queryKey: ['entry-translations', siteSlug, collection, slug],
    queryFn: () => api.entries.translations(collection, slug),
    enabled: Boolean(siteSlug),
  })

  // Candidates to link: other posts in this collection. Filtered to one row per piece so the same
  // candidate is not offered once per language it already has.
  const candidates = useQuery({
    queryKey: ['entry-link-candidates', siteSlug, collection],
    queryFn: () => api.entries.list(collection, { limit: 100, groupBy: 'post' }),
    enabled: Boolean(siteSlug),
  })

  const written = translations.data ?? []
  const mine = new Set(written.map((one) => one.slug))
  const linkable = (candidates.data?.data ?? []).filter((entry) => !mine.has(entry.slug))

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['entry-translations'] })
    queryClient.invalidateQueries({ queryKey: ['entry-link-candidates'] })
    queryClient.invalidateQueries({ queryKey: ['entries'] })
    queryClient.invalidateQueries({ queryKey: ['entry'] })
  }

  const link = useMutation({
    mutationFn: (target: string) => api.entries.linkTranslation(collection, slug, { slug: target }),
    onSuccess: () => {
      setPick('')
      refresh()
      toast.success(t('translations.linked'))
    },
    onError: (error) => toast.error(error.message),
  })

  const unlink = useMutation({
    mutationFn: (which: string) => api.entries.unlinkTranslation(collection, slug, which),
    onSuccess: () => {
      refresh()
      toast.success(t('translations.unlinked'))
    },
    onError: (error) => toast.error(error.message),
  })

  // Nothing to say on a site that publishes one language.
  if (siteLocales.length < 2) return null

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <Label>{t('translations.title')}</Label>
        <p className="text-muted-foreground text-xs">{t('translations.hint')}</p>
      </div>

      <ul className="space-y-1">
        {siteLocales.map((code) => {
          const variant = written.find((one) => one.locale === code)
          return (
            <li key={code} className="flex items-center justify-between gap-2 text-sm">
              <button
                type="button"
                // Each language has its own slug now, so navigating by the current one would open
                // the wrong entry. A language with no variant yet keeps this post's slug, which is
                // what makes the editor open its blank form rather than 404.
                onClick={() =>
                  navigate(
                    `/collections/${collection}/entries/${variant?.slug ?? slug}?locale=${code}`,
                  )
                }
                className={`truncate text-left hover:underline ${
                  code === locale ? 'font-medium' : ''
                } ${variant ? '' : 'text-muted-foreground'}`}
              >
                {localeLabel(code)}
                <span className="ml-2 text-muted-foreground text-xs">
                  {variant ? `/${variant.slug}` : t('translations.notWritten')}
                </span>
              </button>
              {/* Splitting off the language being edited is the only unambiguous case to offer:
                  it is the row this editor is looking at. The last one left has nothing to leave. */}
              {variant && code === locale && written.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('translations.unlink')}
                  title={t('translations.unlink')}
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate(code)}
                >
                  <Unlink className="size-3.5" />
                </Button>
              )}
            </li>
          )
        })}
      </ul>

      {linkable.length > 0 && (
        <div className="space-y-2">
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('translations.linkPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {linkable.map((entry) => (
                <SelectItem key={entry.id} value={entry.slug}>
                  {String(entry.data.title ?? entry.slug)} · {entry.locale}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!pick || link.isPending}
            onClick={() => link.mutate(pick)}
          >
            <Link2 className="size-3.5" />
            {t('translations.link')}
          </Button>
          <p className="text-muted-foreground text-xs">{t('translations.linkHint')}</p>
        </div>
      )}
    </div>
  )
}

export type { EntryTranslation }
