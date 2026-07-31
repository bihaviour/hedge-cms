import { mediaValueOrigin, websiteOrigin } from '@hedge/core'
import { useCallback } from 'react'
import { useActiveSite } from '@/hooks/use-site'

/**
 * How the admin renders a thumbnail for whatever a `media` field happens to hold.
 *
 * The three origins are decided by `mediaValueOrigin` in `@hedge/core`, the same function the
 * delivery API resolves with, so a preview here and the URL a website receives can never disagree
 * about what a stored value is.
 *
 * Null means "there is nothing to show" rather than "show a broken image": a `/public` path
 * belongs to the website, and this admin is served from the CMS origin, so without a recorded
 * website URL there is no origin to fetch it from. Guessing one would render a 404 in a place an
 * operator reads as "your image is missing".
 */
export function useMediaPreviewUrl(): (value: string) => string | null {
  const site = useActiveSite().site
  const websiteUrl = site ? websiteOrigin(site) : null

  return useCallback(
    (value: string): string | null => {
      switch (mediaValueOrigin(value)) {
        case 'url':
          return value
        case 'site-path':
          return websiteUrl ? `${websiteUrl}${encodeURI(value)}` : null
        case 'key':
          // The admin is served by the same Worker as `/media`, so a key needs no origin.
          return `/media/${encodeURI(value)}`
      }
    },
    [websiteUrl],
  )
}
