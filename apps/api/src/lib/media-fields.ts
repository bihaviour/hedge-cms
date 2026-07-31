import { type Field, mediaValueOrigin, mediaValueUrl, type ResolvedMedia } from '@hedge/core'

/**
 * Turning the R2 keys stored in an entry's `media` fields into URLs a browser can actually
 * fetch — the delivery-side half of "keys in, URLs out".
 *
 * The admin already does this for every thumbnail it renders (`toMedia` builds
 * `${PUBLIC_URL}/media/${key}`); the delivery API passed `data` through verbatim, so a frontend
 * rendering `<img src={entry.data.cover} />` emitted a relative path the browser resolved
 * against the *website's* origin, landing in a static directory where the file does not exist.
 *
 * The resolution is a sibling of `data`, never a replacement for it: changing a field's type
 * from string to object would break every consumer that exists today.
 *
 * Not every stored value is a key, and the ones that are not are the reason a site can adopt a
 * `media` field without a migration first. A field that used to be plain text holds `/public`
 * paths, and treating one as a key produced `…/media//covers/photo.png` — the exact class of
 * silent breakage this module exists to remove. `mediaValueOrigin` in `@hedge/core` is the one
 * place that decides, so the admin's thumbnail and this resolution can never disagree.
 */

/** What the delivery API attaches per entry: field name → one resolved item, or a list of them. */
export type ResolvedMediaFields = Record<string, ResolvedMedia | ResolvedMedia[]>

/** The subset of a media row this needs; the real one carries more. */
export interface MediaLookup {
  key: string
  alt: string | null
  width: number | null
  height: number | null
}

export function mediaFieldsOf(fields: Field[]): Field[] {
  return fields.filter((field) => field.kind === 'media')
}

/** Stored in this deployment's bucket, and therefore ours to look up and to build a URL for. */
function isStoredKey(value: string): boolean {
  return mediaValueOrigin(value) === 'key'
}

/**
 * The same key-or-URL question for a single metadata value, answered non-additively.
 *
 * `ogImage` accepts "a media key or URL" in the admin, and a key reaching
 * `<meta property="og:image" content="blog/2026/…">` is simply invalid: Open Graph requires an
 * absolute URL, so a relative one fails silently in every social preview with no workaround on
 * the frontend. There is no additive option here — the tag has one slot — so the resolved
 * metadata carries the absolute form, and a value that was already absolute is left alone.
 *
 * A `/public` path is absolute *once it is joined to the website it belongs to*, which is what
 * `websiteUrl` is for. Without one there is nothing truthful to build, so the path stays as it
 * is: an OG tag a crawler ignores is a smaller failure than one pointing confidently at a CMS
 * URL that 404s.
 */
export function absoluteMediaUrl(
  value: string | undefined,
  publicUrl: string,
  websiteUrl?: string | null,
): string | undefined {
  if (!value) return value
  return mediaValueUrl(value, publicUrl, websiteUrl)
}

function valuesOf(raw: unknown): string[] {
  if (typeof raw === 'string') return raw ? [raw] : []
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string')
  return []
}

/**
 * Every key referenced by the media fields of a set of entries, deduplicated — so a page of
 * twenty entries costs one query rather than twenty.
 */
export function collectMediaKeys(fields: Field[], datas: Record<string, unknown>[]): string[] {
  const keys = new Set<string>()
  for (const field of mediaFieldsOf(fields)) {
    for (const data of datas) {
      for (const value of valuesOf(data[field.name])) {
        // Only a key names a row in this site's library. A URL and a `/public` path are somebody
        // else's file, so querying for them would return nothing and cost a round trip to learn it.
        if (isStoredKey(value)) keys.add(value)
      }
    }
  }
  return [...keys]
}

function resolveOne(
  value: string,
  rows: Map<string, MediaLookup>,
  publicUrl: string,
  websiteUrl: string | null,
): ResolvedMedia {
  // Not ours: an absolute URL, or a file in the website's own static directory. Either way there
  // is no row to carry alt text or dimensions, and `key` stays null so a consumer can tell the
  // difference between "this is in the library" and "this merely renders".
  if (!isStoredKey(value)) {
    return {
      key: null,
      url: mediaValueUrl(value, publicUrl, websiteUrl),
      alt: null,
      width: null,
      height: null,
    }
  }

  const row = rows.get(value)
  // A key with no row is a typo, or a file deleted after it was referenced. The URL is still
  // the one the CMS would serve it at, so it is built anyway — a 404 on the image points at the
  // missing object, where dropping the field would only make the entry look like it never had one.
  return {
    key: value,
    url: `${publicUrl}/media/${value}`,
    alt: row?.alt ?? null,
    width: row?.width ?? null,
    height: row?.height ?? null,
  }
}

/**
 * The resolved sibling for one entry. A `multiple` field resolves to an array in the order it
 * was stored; a single one to an object. A field with no value is omitted entirely rather than
 * carrying a null, so `entry.media.cover` is either usable or absent.
 */
export function resolveMediaFields(
  fields: Field[],
  data: Record<string, unknown>,
  rows: Map<string, MediaLookup>,
  publicUrl: string,
  websiteUrl: string | null = null,
): ResolvedMediaFields {
  const resolved: ResolvedMediaFields = {}

  for (const field of mediaFieldsOf(fields)) {
    const values = valuesOf(data[field.name])
    if (values.length === 0) continue

    const items = values.map((value) => resolveOne(value, rows, publicUrl, websiteUrl))
    // `multiple` decides the shape, not how many values happen to be stored — a one-item list
    // stays a list, so a frontend can map over it without checking.
    resolved[field.name] = 'multiple' in field && field.multiple ? items : items[0]!
  }

  return resolved
}
