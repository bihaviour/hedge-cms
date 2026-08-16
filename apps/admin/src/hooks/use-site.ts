import { hasSitePermission, type Site, type SitePermission } from '@hedge/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { getActiveSite, setActiveSite, subscribeToActiveSite } from '@/lib/active-site'
import { api } from '@/lib/api'

export function useSites({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: ['sites'], queryFn: api.sites.list, staleTime: 60_000, enabled })
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

/**
 * What the signed-in person may do on the active site: their site role, and the approval level in
 * force for them there.
 *
 * Its own query rather than a field on the session, because both are per site and the session is
 * not — the same user can be an admin on one site and a viewer on the next. Keyed on the site slug
 * like every other site-scoped query, so switching site asks again instead of gating on the answer
 * for the previous tenant.
 *
 * What it drives is cosmetic: the server checks every one of these powers for itself. It is what
 * keeps the admin from offering a control whose only possible answer is a 403 toast.
 */
export function useSiteAuthority() {
  const siteSlug = useSyncExternalStore(subscribeToActiveSite, getActiveSite)
  return useQuery({
    queryKey: ['site-authority', siteSlug],
    queryFn: api.access.get,
    enabled: Boolean(siteSlug),
  })
}

/**
 * Whether the person may do one thing on the active site. False while the answer is still loading —
 * a control that appears once authority resolves is better than one that appears for everybody and
 * then disappears for some.
 *
 * **Gate on the permission, never on the role slug** (#151). A deployment defines its own roles and
 * edits the built-in ones, so "is this person an admin here" stopped being a question with a fixed
 * meaning; "may they delete an entry" did not. The server answers the same question the same way.
 */
export function useSitePermission(permission: SitePermission): boolean {
  const authority = useSiteAuthority()
  return authority.data ? hasSitePermission(authority.data.permissions, permission) : false
}

/** Switching site invalidates everything — all content queries are scoped to one tenant. */
export function useSwitchSite() {
  const queryClient = useQueryClient()
  return (slug: string) => {
    setActiveSite(slug)
    queryClient.invalidateQueries()
  }
}
