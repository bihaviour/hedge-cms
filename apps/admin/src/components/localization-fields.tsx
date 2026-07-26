import { COMMON_TIMEZONES, LOCALES, localeLabel } from '@hedge/core'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useT } from '@/lib/i18n'

export interface LocalizationValue {
  locales: string[]
  defaultLocale: string
  timezone: string
}

/**
 * The per-site i18n editor: enabled content locales, which one is served by default, and the
 * timezone the admin renders the site's dates in. Fully controlled, so both the new-site dialog and
 * the per-site localization dialog can drive it from their own state.
 *
 * It keeps its own invariants so the parent never has to: the default locale always sits inside the
 * enabled set, and the last locale can't be removed.
 */
export function LocalizationFields({
  value,
  onChange,
}: {
  value: LocalizationValue
  onChange: (value: LocalizationValue) => void
}) {
  const t = useT()

  // The timezone list, with the current value grafted in if a site was configured with one that is
  // not in the curated set — so editing a site never silently drops its timezone.
  const timezones = COMMON_TIMEZONES.includes(value.timezone)
    ? COMMON_TIMEZONES
    : [value.timezone, ...COMMON_TIMEZONES]

  const available = LOCALES.filter((locale) => !value.locales.includes(locale.code))

  function addLocale(code: string) {
    if (value.locales.includes(code)) return
    onChange({ ...value, locales: [...value.locales, code] })
  }

  function removeLocale(code: string) {
    if (value.locales.length <= 1) return
    const locales = value.locales.filter((locale) => locale !== code)
    // Removing the default falls back to whatever locale is now first, so it stays inside the set.
    const defaultLocale = value.defaultLocale === code ? locales[0]! : value.defaultLocale
    onChange({ ...value, locales, defaultLocale })
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>{t('sites.localesLabel')}</Label>
        <div className="flex flex-wrap gap-2">
          {value.locales.map((code) => (
            <Badge key={code} variant="secondary" className="gap-1 pr-1">
              {localeLabel(code)}
              <span className="font-mono text-muted-foreground text-xs">{code}</span>
              {value.locales.length > 1 && (
                <button
                  type="button"
                  aria-label={t('sites.removeLocaleAria', { locale: code })}
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                  onClick={() => removeLocale(code)}
                >
                  <X className="size-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
        {available.length > 0 && (
          <Select value="" onValueChange={addLocale}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('sites.addLocale')} />
            </SelectTrigger>
            <SelectContent>
              {available.map((locale) => (
                <SelectItem key={locale.code} value={locale.code}>
                  {locale.native} · {locale.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-muted-foreground text-xs">{t('sites.localesHint')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="default-locale">{t('sites.defaultLocaleLabel')}</Label>
        <Select
          value={value.defaultLocale}
          onValueChange={(defaultLocale) => onChange({ ...value, defaultLocale })}
        >
          <SelectTrigger id="default-locale">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {value.locales.map((code) => (
              <SelectItem key={code} value={code}>
                {localeLabel(code)} · {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t('sites.defaultLocaleHint')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="timezone">{t('sites.timezoneLabel')}</Label>
        <Select
          value={value.timezone}
          onValueChange={(timezone) => onChange({ ...value, timezone })}
        >
          <SelectTrigger id="timezone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {timezones.map((zone) => (
              <SelectItem key={zone} value={zone}>
                {zone}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t('sites.timezoneHint')}</p>
      </div>
    </div>
  )
}
