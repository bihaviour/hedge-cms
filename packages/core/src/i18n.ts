import { z } from 'zod'

/**
 * Internationalization primitives shared by the Worker and the admin.
 *
 * A site carries three i18n settings, and every one of them is *per site*: the set of content
 * locales it publishes, which of those is served when a request names none, and the timezone its
 * editors think in. One deployment can run an English blog and a bilingual (en/id) docs site side
 * by side, each with its own defaults — the config lives on the `sites` row, not on the instance.
 *
 * The admin UI's own display language is a separate concern: that is a viewer preference (per
 * browser), because one operator may manage sites in several languages and should read the chrome
 * in theirs regardless of which tenant they are in.
 */

/** Served when a request names no locale, and the seed value for a new site. */
export const DEFAULT_LOCALE = 'en'

/** UTC is the only safe default: it is what every timestamp is already stored in. */
export const DEFAULT_TIMEZONE = 'UTC'

/**
 * A content locale code. Deliberately looser than full BCP-47 — a language subtag, optionally with
 * a region or script (`en`, `pt-BR`, `zh-Hant`) — which is all the delivery API keys entries by.
 * The 2–12 length keeps it in step with the entry schema, which predates this file.
 */
export const localeCodeSchema = z
  .string()
  .min(2)
  .max(12)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'must be a language code like "en" or "pt-BR"')

export type LocaleCode = z.infer<typeof localeCodeSchema>

/**
 * A curated set of locales the admin offers in its pickers. Not a limit — `localeCodeSchema`
 * accepts any well-formed code, so a site can enable one that is not listed — just the common
 * ones, each with an English name and its own endonym so a speaker recognises it in the list.
 */
export interface LocaleOption {
  code: string
  /** The language's name in English, for an operator scanning the list. */
  english: string
  /** The language's name in its own script, for a native speaker. */
  native: string
}

export const LOCALES: readonly LocaleOption[] = [
  { code: 'en', english: 'English', native: 'English' },
  { code: 'id', english: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'es', english: 'Spanish', native: 'Español' },
  { code: 'pt', english: 'Portuguese', native: 'Português' },
  { code: 'pt-BR', english: 'Portuguese (Brazil)', native: 'Português (Brasil)' },
  { code: 'fr', english: 'French', native: 'Français' },
  { code: 'de', english: 'German', native: 'Deutsch' },
  { code: 'it', english: 'Italian', native: 'Italiano' },
  { code: 'nl', english: 'Dutch', native: 'Nederlands' },
  { code: 'ru', english: 'Russian', native: 'Русский' },
  { code: 'ja', english: 'Japanese', native: '日本語' },
  { code: 'ko', english: 'Korean', native: '한국어' },
  { code: 'zh', english: 'Chinese', native: '中文' },
  { code: 'zh-Hant', english: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'ar', english: 'Arabic', native: 'العربية' },
  { code: 'hi', english: 'Hindi', native: 'हिन्दी' },
  { code: 'th', english: 'Thai', native: 'ไทย' },
  { code: 'vi', english: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'tr', english: 'Turkish', native: 'Türkçe' },
  { code: 'pl', english: 'Polish', native: 'Polski' },
]

const LOCALE_BY_CODE = new Map(LOCALES.map((locale) => [locale.code, locale]))

/**
 * A human label for a locale code. Prefers the curated list, then the runtime's own
 * `Intl.DisplayNames` (so `fr-CA` reads as "French (Canada)" even though it is not listed), and
 * finally the raw code — never throws, so it is safe to call on whatever a site has stored.
 */
export function localeLabel(code: string, display: 'english' | 'native' = 'english'): string {
  const known = LOCALE_BY_CODE.get(code)
  if (known) return display === 'native' ? known.native : known.english

  try {
    const language = display === 'native' ? code : 'en'
    const name = new Intl.DisplayNames([language], { type: 'language' }).of(code)
    if (name && name !== code) return name
  } catch {
    // Intl.DisplayNames is missing or the code is malformed — fall through to the code itself.
  }
  return code
}

/**
 * Is this a timezone the runtime understands? `Intl.DateTimeFormat` throws a `RangeError` on an
 * unknown IANA name, which is the most portable validity check there is — it works the same in a
 * Worker, in Bun and in a browser without shipping a zone table.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** An IANA timezone name (`UTC`, `Asia/Jakarta`), validated against the runtime's own zone table. */
export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'must be an IANA timezone like "Asia/Jakarta"' })

/**
 * The enabled content locales for a site. Bounded and de-duplicated: a site with two hundred
 * "locales", or the same one twice, is a mistake, not a use case.
 */
export const localesSchema = z
  .array(localeCodeSchema)
  .min(1, 'a site must publish in at least one locale')
  .max(50)
  .refine((locales) => new Set(locales).size === locales.length, {
    message: 'locales must be unique',
  })

/**
 * A small, editor-friendly set of timezones for the admin's picker, grouped loosely by region.
 * As with `LOCALES` this is a convenience, not a constraint — `timezoneSchema` accepts any valid
 * IANA name the browser reports.
 */
export const COMMON_TIMEZONES: readonly string[] = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
]

/**
 * The i18n block of a site, validated as a unit so `defaultLocale` can never point at a locale the
 * site does not publish. Reused by the create and update site schemas.
 */
export const siteI18nSchema = z
  .object({
    locales: localesSchema,
    defaultLocale: localeCodeSchema,
    timezone: timezoneSchema,
  })
  .refine((value) => value.locales.includes(value.defaultLocale), {
    message: 'the default locale must be one of the enabled locales',
    path: ['defaultLocale'],
  })

export type SiteI18n = z.infer<typeof siteI18nSchema>

/** The i18n defaults a brand-new site starts with: English only, UTC. */
export function defaultSiteI18n(): SiteI18n {
  return { locales: [DEFAULT_LOCALE], defaultLocale: DEFAULT_LOCALE, timezone: DEFAULT_TIMEZONE }
}
