/**
 * Comparing two field maps, field by field.
 *
 * Lifted out of `entry-revisions.tsx` when versions needed the same reading. Both callers ask the
 * same question — which fields differ, and what does each side say — and for the two-writers case it
 * is *the* useful reading: which fields the second writer touched, and which they left alone.
 */

export type ChangeKind = 'changed' | 'added' | 'removed'

export interface FieldChange {
  name: string
  kind: ChangeKind
  left: unknown
  right: unknown
}

/** Structural equality via JSON, which is what these values are: they round-trip through the API. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const isEmpty = (value: unknown) => value === undefined || value === null || value === ''

/**
 * Every field where `left` and `right` disagree, in the order the fields appear — `left` first, then
 * whatever only `right` has. `added` and `removed` are relative to `left`, so a caller can say
 * "this version adds a field" rather than only "these differ".
 */
export function diffFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): FieldChange[] {
  const names = [...Object.keys(left), ...Object.keys(right).filter((name) => !(name in left))]

  return names
    .filter((name) => !same(left[name], right[name]))
    .map((name) => ({
      name,
      kind: isEmpty(left[name]) ? 'added' : isEmpty(right[name]) ? 'removed' : 'changed',
      left: left[name],
      right: right[name],
    }))
}

/** A field value as something readable in a diff cell. Strings stay strings; anything else is JSON. */
export function previewValue(value: unknown): string {
  if (value === undefined || value === null) return '—'
  return typeof value === 'string' ? value || '—' : JSON.stringify(value, null, 2)
}
