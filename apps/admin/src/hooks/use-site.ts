import type { Site } from '@hedge/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { getActiveSite, setActiveSite, subscribeToActiveSite } from '@/lib/active-site'
import { api } from '@/lib/api'

export function useSites() {
  return useQuery({ queryKey: ['sites'], queryFn: api.sites.list, staleTime: 60_000 })
}

/**
 * The active site's slug, for query keys. Every site-scoped query must include it: it keeps one
 * tenant's cache from standing in for another's, and it is what makes the query re-run once the
 * site is known (or changes) instead of holding on to a result fetched without one.
 */
export function useActiveSiteSlug(): string | null {
  return useSyncExternalStore(subscribeToActiveSite, getActiveSite)
}

/**
 * The site the admin is working in. Falls back to the first site whenever the stored one is
 * gone — a site can be deleted, or the account can lose access to it, and the UI should recover
 * rather than sit on a slug the API will 404.
 */
export function useActiveSite(): { site: Site | undefined; sites: Site[]; isLoading: boolean } {
  const slug = useSyncExternalStore(subscribeToActiveSite, getActiveSite)
  const sites = useSites()

  const list = sites.data ?? []
  const match = list.find((site) => site.slug === slug)

  useEffect(() => {
    if (list.length > 0 && !match) setActiveSite(list[0]!.slug)
  }, [list, match])

  return { site: match, sites: list, isLoading: sites.isLoading }
}

/** Switching site invalidates everything — all content queries are scoped to one tenant. */
export function useSwitchSite() {
  const queryClient = useQueryClient()
  return (slug: string) => {
    setActiveSite(slug)
    queryClient.invalidateQueries()
  }
}
