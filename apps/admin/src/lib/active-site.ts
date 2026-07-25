import { SITE_HEADER } from '@hedge/core'

/**
 * Which site the admin is currently working in. Kept outside React so `lib/api.ts` can read it
 * synchronously when building request headers, and mirrored to `localStorage` so a reload lands
 * you back where you were.
 */

const STORAGE_KEY = 'hedge.active-site'

let current: string | null = localStorage.getItem(STORAGE_KEY)
const listeners = new Set<() => void>()

export function getActiveSite(): string | null {
  return current
}

export function setActiveSite(slug: string | null): void {
  if (current === slug) return
  current = slug
  if (slug) localStorage.setItem(STORAGE_KEY, slug)
  else localStorage.removeItem(STORAGE_KEY)
  for (const listener of listeners) listener()
}

export function subscribeToActiveSite(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Header the API reads to scope a request to one tenant. */
export function siteHeaders(): Record<string, string> {
  return current ? { [SITE_HEADER]: current } : {}
}
