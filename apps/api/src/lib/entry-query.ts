import type { Field } from '@hedge/core'
import { type AnyColumn, asc, desc, type SQL, sql } from 'drizzle-orm'
import { entries } from '../db/schema'
import { ApiError } from './errors'

/**
 * Sorting and filtering entries by a declared content field, shared by the delivery API
 * (`routes/content.ts`) and the management list (`lib/entries.ts`) so the two agree.
 *
 * The whole thing leans on D1 being SQLite: a field is addressed as `json_extract(data, '$.name')`,
 * and only fields declared on the collection are addressable — everything reachable here has been
 * checked against the collection's `fields`, so a caller can never name a JSON path we did not
 * declare. That keeps this validated input rather than an open query language.
 *
 * A `json_extract` over an unindexed JSON column is a scan today. The API is shaped so a later
 * expression index (`CREATE INDEX … ON entries (json_extract(data, '$.date'))`) is a pure
 * optimisation rather than a breaking change.
 */

/** Only `number` fields sort and compare numerically; everything else is compared as text. */
const isNumericField = (field: Field) => field.kind === 'number'

/** Fields stored as an array — a `contains` filter over one is a membership test, not a substring. */
const isArrayField = (field: Field) => 'multiple' in field && field.multiple === true

/**
 * The SQL value a declared field is sorted and compared by. Cast so the ordering is deterministic
 * and matches how the cursor value round-trips: numbers as REAL, everything else as TEXT (ISO dates
 * included, which sort chronologically as text).
 */
function jsonValue(name: string, numeric: boolean): SQL {
  // `name` is always a declared field name (`/^[a-z][a-z0-9_]*$/`), so the path is safe to inline.
  const raw = sql`json_extract(${entries.data}, ${`$.${name}`})`
  return numeric ? sql`cast(${raw} as real)` : sql`cast(${raw} as text)`
}

/** A resolved sort target: the expression to order and page by. */
export interface SortTarget {
  expr: SQL
}

/**
 * Resolve a `sort` parameter to a SQL expression. A bare name is one of the built-in `columns`; a
 * `data.<field>` / `field:<field>` name is a declared content field. Anything else — an unknown
 * column, or a field the collection does not declare — is a 400.
 */
export function resolveSort(
  sort: string,
  fields: Field[],
  columns: Record<string, AnyColumn>,
): SortTarget {
  const fieldName = sort.startsWith('data.')
    ? sort.slice('data.'.length)
    : sort.startsWith('field:')
      ? sort.slice('field:'.length)
      : null

  if (fieldName === null) {
    const column = columns[sort]
    if (!column) {
      throw ApiError.badRequest(`Cannot sort by "${sort}"`, {
        sort: [`sort by one of ${Object.keys(columns).join(', ')}, or a field as "data.<field>"`],
      })
    }
    // Wrap the column so a sort target is always a SQL expression, whichever branch it came from.
    return { expr: sql`${column}` }
  }

  const field = fields.find((f) => f.name === fieldName)
  if (!field) {
    throw ApiError.badRequest(`Cannot sort by undeclared field "${fieldName}"`, {
      sort: [`"${fieldName}" is not a field on this collection`],
    })
  }
  return { expr: jsonValue(field.name, isNumericField(field)) }
}

/**
 * The ORDER BY for a keyset page: the sort target, then `id` as a tie-break. The tie-break is
 * load-bearing — `publishedAt` gets a unique order for free from timestamp-prefixed ids, but a
 * content field like `date` can repeat, and without falling back to `id` a page boundary could drop
 * or duplicate rows that share a value.
 */
export function orderByClause(target: SortTarget, order: 'asc' | 'desc'): SQL[] {
  const dir = order === 'desc' ? desc : asc
  return [dir(target.expr), dir(entries.id)]
}

/** One page's worth of keyset state: the last row's sort value and its id. */
export interface Cursor {
  value: unknown
  id: string
}

/**
 * The keyset predicate for "rows after this cursor" in the chosen order, with the same `id`
 * tie-break the ORDER BY uses so a shared sort value cannot straddle a page boundary.
 */
export function cursorCondition(target: SortTarget, order: 'asc' | 'desc', cursor: Cursor): SQL {
  const { value, id } = cursor
  // `value` round-trips through the cursor with its original type (a number for a numeric field, a
  // string otherwise), so the bound comparison matches the cast used to order — no coercion here.
  return order === 'desc'
    ? sql`(${target.expr} < ${value} or (${target.expr} = ${value} and ${entries.id} < ${id}))`
    : sql`(${target.expr} > ${value} or (${target.expr} = ${value} and ${entries.id} > ${id}))`
}

/**
 * The predicate for "one row per post rather than one per translation": keeps the variant a reader
 * should be served, and drops the post's other languages from the result.
 *
 * The preference is `preferred` locale, then `fallback` — the site's default — then the oldest
 * variant the post has. That last step is the one worth stating plainly: a post published *only* in
 * a language the site does not default to still exists, and dropping it from every list would hide
 * content somebody published. So the list never has holes, and the caller is told which locale it
 * was actually handed rather than being left to assume it got the one it asked for.
 *
 * Written as a correlated `id = (select … limit 1)` rather than a `GROUP BY` because the preference
 * is an *ordering*, not an aggregate: the chosen row has to survive the outer query's own sort, its
 * cursor and its field filters, all of which operate on whole rows. The subquery is an indexed
 * lookup on `entries_translation_group_idx`.
 *
 * `publishedOnly` has to be applied *inside* the subquery as well as outside it. A post whose
 * Indonesian variant is still a draft should fall back to its published English one — if the filter
 * ran only on the outer query the draft would win the pick and then be filtered away, and the post
 * would vanish from the list instead of falling back.
 */
export function onePerTranslationGroup(
  preferred: string,
  fallback: string,
  options: { publishedOnly?: boolean } = {},
): SQL {
  const visible = options.publishedOnly ? sql` and variant.status = 'published'` : sql``
  return sql`${entries.id} = (
    select variant.id from ${entries} as variant
    where variant.translation_group_id = ${entries.translationGroupId}${visible}
    order by (variant.locale = ${preferred}) desc, (variant.locale = ${fallback}) desc, variant.id asc
    limit 1
  )`
}

export const FILTER_OPS = ['eq', 'contains', 'gte', 'lte'] as const
export type FilterOp = (typeof FILTER_OPS)[number]

export interface EntryFilter {
  field: Field
  op: FilterOp
  /** Raw string from the query; coerced per the field's kind when the condition is built. */
  value: string
}

/**
 * Parse `where[field][op]=value` params into filters, resolving each field against the collection.
 * An undeclared field is a 400, so this stays validated input rather than an arbitrary JSON path.
 */
export function parseEntryFilters(params: URLSearchParams, fields: Field[]): EntryFilter[] {
  const filters: EntryFilter[] = []
  for (const [key, value] of params) {
    const match = /^where\[([a-z][a-z0-9_]*)\]\[(eq|contains|gte|lte)\]$/.exec(key)
    if (!match) continue
    const name = match[1]!
    const field = fields.find((f) => f.name === name)
    if (!field) {
      throw ApiError.badRequest(`Cannot filter by undeclared field "${name}"`, {
        [`where[${name}]`]: [`"${name}" is not a field on this collection`],
      })
    }
    filters.push({ field, op: match[2] as FilterOp, value })
  }
  return filters
}

function filterCondition({ field, op, value }: EntryFilter): SQL {
  const numeric = isNumericField(field)
  const expr = jsonValue(field.name, numeric)
  const bound: string | number = numeric ? Number(value) : value

  switch (op) {
    case 'eq':
      return sql`${expr} = ${bound}`
    case 'gte':
      return sql`${expr} >= ${bound}`
    case 'lte':
      return sql`${expr} <= ${bound}`
    case 'contains':
      // A multi-valued field (tags, a multi-select) is a JSON array, so `contains` is membership.
      // A scalar field falls back to a substring match on its text form.
      return isArrayField(field)
        ? sql`exists (select 1 from json_each(${entries.data}, ${`$.${field.name}`}) where json_each.value = ${value})`
        : sql`${jsonValue(field.name, false)} like ${`%${value}%`}`
  }
}

export function whereConditions(filters: EntryFilter[]): SQL[] {
  return filters.map(filterCondition)
}

/**
 * Cursors are opaque to callers and carry the sort value plus the tie-break id. Encoded as URL-safe
 * base64 of JSON so a value's type (and any non-ASCII text) survives the round trip.
 */
export function encodeCursor(value: unknown, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([value ?? null, id]))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCursor(cursor: string): Cursor {
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as [unknown, unknown]
    if (!Array.isArray(parsed) || typeof parsed[1] !== 'string') throw new Error('malformed cursor')
    return { value: parsed[0], id: parsed[1] }
  } catch {
    throw ApiError.badRequest('Invalid pagination cursor')
  }
}
