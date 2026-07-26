import { UI_LANGUAGES } from './catalog'

/**
 * The admin's display language. Kept outside React — like the active site — so it can be read
 * synchronously and mirrored to `localStorage`, and subscribed to with `useSyncExternalStore`.
 * This is a per-browser preference, not per-site: see `catalog.ts`.
 */

const STORAGE_KEY = 'hedge.ui-language'

const SUPPORTED = new Set(UI_LANGUAGES.map((language) => language.code))

/** The browser's preferred language, if we ship a catalog for it — else English. */
function detect(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && SUPPORTED.has(stored)) return stored

  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.split('-')[0]
    if (base && SUPPORTED.has(base)) return base
  }
  return 'en'
}

let current = detect()
const listeners = new Set<() => void>()

export function getUiLanguage(): string {
  return current
}

export function setUiLanguage(code: string): void {
  if (current === code || !SUPPORTED.has(code)) return
  current = code
  localStorage.setItem(STORAGE_KEY, code)
  for (const listener of listeners) listener()
}

export function subscribeToUiLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
