import { useSyncExternalStore } from 'react'
import { useActiveSite } from '@/hooks/use-site'
import { type Catalog, en, type MessageKey } from './catalog'
import { id } from './id'
import { getUiLanguage, setUiLanguage, subscribeToUiLanguage } from './store'

export { UI_LANGUAGES, type UiLanguage } from './catalog'
export { getUiLanguage, setUiLanguage } from './store'

const CATALOGS: Record<string, Catalog> = { en, id }

/** Substitutes `{name}` placeholders from `vars`; leaves an unmatched one untouched. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
}

/**
 * Look up a message in the given language, falling back to English and finally the key itself, so a
 * missing translation degrades to English rather than a raw identifier the user should never see.
 */
export function translate(
  language: string,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const message = CATALOGS[language]?.[key] ?? en[key] ?? key
  return interpolate(message, vars)
}

export type TranslateFn = (key: MessageKey, vars?: Record<string, string | number>) => string

/** The current display language, re-rendering the caller when it changes. */
export function useUiLanguage(): string {
  return useSyncExternalStore(subscribeToUiLanguage, getUiLanguage)
}

/** `t('some.key')` bound to the current language. The workhorse hook for every translated string. */
export function useT(): TranslateFn {
  const language = useUiLanguage()
  return (key, vars) => translate(language, key, vars)
}

/** `[code, setCode]`, for the language switcher. */
export function useLanguageSetting(): [string, (code: string) => void] {
  return [useUiLanguage(), setUiLanguage]
}

export interface Formatters {
  /** A date, in the active site's timezone and the admin's display language. */
  formatDate: (value: string | null | undefined) => string
  /** A date with the time of day, in the active site's timezone. */
  formatDateTime: (value: string | null | undefined) => string
  /** The IANA timezone these formatters are pinned to (the active site's, or UTC). */
  timeZone: string
}

/**
 * Date formatters bound to two i18n settings at once: the *site's* timezone (so an editor in
 * Jakarta reads Jakarta time regardless of where the Worker runs) and the *viewer's* display
 * language (so month names match the rest of the chrome). Timezone is per-site, language is
 * per-viewer — the two are deliberately independent.
 */
export function useFormatters(): Formatters {
  const language = useUiLanguage()
  const { site } = useActiveSite()
  const timeZone = site?.timezone || 'UTC'

  const format = (
    value: string | null | undefined,
    options: Intl.DateTimeFormatOptions,
  ): string => {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat(language, { ...options, timeZone }).format(date)
  }

  return {
    timeZone,
    formatDate: (value) => format(value, { year: 'numeric', month: 'short', day: 'numeric' }),
    formatDateTime: (value) =>
      format(value, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }),
  }
}
