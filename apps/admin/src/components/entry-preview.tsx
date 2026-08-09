import { useMutation } from '@tanstack/react-query'
import { ExternalLink, Eye } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useActiveSite } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'

/**
 * Mints a preview token for one entry and hands the URL to whoever asked for it.
 *
 * Shared by the editor's button and the entries table's row menu, so the two cannot drift into
 * minting tokens differently — what they do differ on is where the URL lands, which is the callback.
 */
export function usePreviewToken(onUrl: (url: string) => void) {
  const t = useT()

  return useMutation({
    mutationFn: (entry: { collection: string; slug: string; locale: string }) =>
      api.entries.previewToken(entry.collection, entry.slug, entry.locale),
    onSuccess: ({ url }) => {
      // The server builds the URL and returns null when the site has none; the control is hidden in
      // that case, so arriving here without one means the site changed under us.
      if (!url) {
        toast.error(t('preview.notConfigured'))
        return
      }
      onUrl(url)
    },
    onError: (error) => toast.error(error.message),
  })
}

/**
 * "See this entry the way a reader would" — which only the website can do, because Hedge is
 * headless and has no layout of its own. Minting a token and opening the site's preview route is
 * therefore the whole of this component.
 *
 * Two ways to reach it, and the ordering is deliberate:
 *
 * 1. **A new tab.** Always works, and the default.
 * 2. **An embedded pane**, when the operator has switched it on for this site. Nicer, and blocked
 *    whenever the target sends `X-Frame-Options` or a `Content-Security-Policy` whose
 *    `frame-ancestors` excludes the CMS origin — which Hedge cannot fix from its side and cannot
 *    reliably detect from the parent document either. So the escape link lives *inside* the pane: a
 *    blank frame must never be a dead end.
 *
 * Preview shows what is **saved**. Showing the live form buffer would need either a signed one-shot
 * echo endpoint or an autosave, and neither is worth it here — once entry versioning lands the
 * natural workflow is "save a version, preview that version".
 */
export function EntryPreview({
  collection,
  slug,
  locale,
  disabled,
}: {
  collection: string
  slug: string
  locale: string
  disabled?: boolean
}) {
  const t = useT()
  const { site } = useActiveSite()
  const [framed, setFramed] = useState<string | null>(null)

  const configured = Boolean(site?.previewUrl)

  const open = usePreviewToken((url) => {
    if (site?.previewEmbed) setFramed(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  })

  if (!configured) {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link to="/settings/configuration">
          <Eye className="size-4" />
          {t('preview.setUp')}
        </Link>
      </Button>
    )
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || open.isPending}
        onClick={() => open.mutate({ collection, slug, locale })}
      >
        <Eye className="size-4" />
        {open.isPending ? t('preview.opening') : t('preview.action')}
      </Button>

      <Dialog open={framed !== null} onOpenChange={(next) => !next && setFramed(null)}>
        <DialogContent className="flex h-[85vh] max-w-[95vw] flex-col gap-3 sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle>{t('preview.title')}</DialogTitle>
            <DialogDescription>{t('preview.framedHint')}</DialogDescription>
          </DialogHeader>

          {/* Inside the pane, not beside it: when the site refuses to be framed this link is the
              only thing the operator can see, and it has to be enough to get them out. */}
          {framed && (
            <a
              className="inline-flex w-fit items-center gap-1.5 text-sm underline"
              href={framed}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-3.5" />
              {t('preview.openTab')}
            </a>
          )}

          {framed && (
            <iframe
              className="min-h-0 flex-1 rounded-md border bg-background"
              src={framed}
              title={t('preview.title')}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
