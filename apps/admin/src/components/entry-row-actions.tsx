import { type Entry, entryPublicUrl } from '@hedge/core'
import { ChartLine, ExternalLink, Eye, MoreHorizontal, Pencil } from 'lucide-react'
import { useNavigate } from 'react-router'
import { usePreviewToken } from '@/components/entry-preview'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActiveSite } from '@/hooks/use-site'
import { useT } from '@/lib/i18n'

/**
 * The four things somebody wants from a row of the entries table: how it did, editing it, seeing
 * the draft, and opening the page a reader gets.
 *
 * They are in a menu rather than four buttons per row because three of them are occasional and the
 * fourth — edit — is already the row's title link. A row of icons repeated down a long table reads
 * as noise and pushes the columns that carry information off the right-hand side.
 *
 * Two of the four can be *absent* rather than merely disabled, and that is deliberate: preview
 * needs the site's preview URL and the live link needs its domain, and offering either without the
 * setting behind it produces a click that goes nowhere. A menu that offers what it can do is worth
 * more than one that always looks the same.
 */
export function EntryRowActions({
  collection,
  previewPath,
  entry,
}: {
  collection: string
  /** The collection's page-shape template, for building the URL the article has on the website. */
  previewPath: string | null
  entry: Entry
}) {
  const t = useT()
  const navigate = useNavigate()
  const { site } = useActiveSite()

  // Always a new tab from here, even on a site that prefers the embedded pane. The pane belongs to
  // the editor, where the entry being previewed is the thing already on screen; a dialog opened out
  // of a menu in a table row covers the list it was opened from.
  const preview = usePreviewToken((url) => window.open(url, '_blank', 'noopener,noreferrer'))

  const editHref = `/collections/${collection}/entries/${entry.slug}?locale=${entry.locale}`
  const liveUrl = entryPublicUrl({
    domain: site?.domain,
    previewPath,
    collection,
    slug: entry.slug,
    locale: entry.locale,
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('entries.rowActions')}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => navigate(`/analytics/${entry.id}`)}>
          <ChartLine className="size-4" />
          {t('entries.actionAnalytics')}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => navigate(editHref)}>
          <Pencil className="size-4" />
          {t('entries.actionEdit')}
        </DropdownMenuItem>

        {site?.previewUrl && (
          <DropdownMenuItem
            disabled={preview.isPending}
            onSelect={() => preview.mutate({ collection, slug: entry.slug, locale: entry.locale })}
          >
            <Eye className="size-4" />
            {preview.isPending ? t('preview.opening') : t('entries.actionPreview')}
          </DropdownMenuItem>
        )}

        {liveUrl && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={liveUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                {t('entries.actionOpenSite')}
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
