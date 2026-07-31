import { z } from 'zod'

/**
 * Field definitions describe the shape of a collection. They are stored as JSON on the
 * `collections` row and are the single source of truth for validating entry data on write
 * and for rendering the entry form in the admin UI.
 */

export const FIELD_KINDS = [
  'text',
  'richtext',
  'number',
  'boolean',
  'date',
  'select',
  'media',
  'reference',
  'url',
  'email',
  'color',
  'json',
  'code',
] as const

export type FieldKind = (typeof FIELD_KINDS)[number]

const baseField = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case and start with a letter'),
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  required: z.boolean().default(false),
  localized: z.boolean().default(false),
})

export const fieldSchema = z.discriminatedUnion('kind', [
  baseField.extend({
    kind: z.literal('text'),
    multiline: z.boolean().default(false),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    pattern: z.string().optional(),
    default: z.string().optional(),
  }),
  baseField.extend({
    kind: z.literal('richtext'),
    format: z.enum(['markdown', 'html']).default('markdown'),
    default: z.string().optional(),
  }),
  baseField.extend({
    kind: z.literal('number'),
    integer: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.number().optional(),
  }),
  baseField.extend({
    kind: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  baseField.extend({
    kind: z.literal('date'),
    includeTime: z.boolean().default(true),
    default: z.string().optional(),
  }),
  baseField.extend({
    kind: z.literal('select'),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
    multiple: z.boolean().default(false),
    // When true the declared `options` are suggestions rather than a closed set: any non-empty
    // string is accepted. This is what turns a `select` into a free-form tag/keyword field without
    // a new field kind — the storage is identical (`string[]` when `multiple`), only the validator
    // changes. See `validatorForField`.
    creatable: z.boolean().default(false),
    default: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  baseField.extend({
    kind: z.literal('media'),
    accept: z.array(z.string()).default([]),
    multiple: z.boolean().default(false),
  }),
  baseField.extend({
    kind: z.literal('reference'),
    collection: z.string().min(1),
    multiple: z.boolean().default(false),
  }),
  baseField.extend({
    kind: z.literal('url'),
    default: z.string().optional(),
  }),
  baseField.extend({
    kind: z.literal('email'),
    default: z.string().optional(),
  }),
  baseField.extend({
    // Stored as a `#rrggbb` hex string, so it round-trips through a native colour input.
    kind: z.literal('color'),
    default: z.string().optional(),
  }),
  baseField.extend({
    kind: z.literal('json'),
  }),
  baseField.extend({
    /**
     * A human-readable editorial identifier — `RB-0007` — assigned by the CMS, never typed. The
     * value is generated on the write path (`applyGeneratedCodes` in the API) the first time an
     * entry is created and is then carried unchanged for the life of that entry, so it can be cited
     * in prose, printed on a page, or used as a stable reference that survives a slug rename.
     *
     * It is deliberately *not* a `text` field with a flag: a code has no editable state at all, so
     * every surface that renders a form has to know it is read-only, and the exhaustiveness check
     * on `FieldKind` is what guarantees none of them forgets.
     */
    kind: z.literal('code'),
    /** Prepended verbatim to the padded sequence — e.g. `RB-` produces `RB-0007`. */
    prefix: z.string().max(16).default(''),
    /** How many digits the sequence is padded to. Numbers past it simply get longer. */
    padding: z.number().int().min(1).max(12).default(4),
  }),
])

export type Field = z.infer<typeof fieldSchema>

export const fieldsSchema = z
  .array(fieldSchema)
  .max(100)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>()
    for (const [i, field] of fields.entries()) {
      if (seen.has(field.name)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `duplicate field name "${field.name}"`,
        })
      }
      seen.add(field.name)
    }
  })

/** Build a zod validator for an entry's `data` payload from its collection's field definitions. */
export function buildEntryValidator(fields: Field[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const field of fields) {
    let schema = validatorForField(field)
    if (!field.required) schema = schema.nullish()
    shape[field.name] = schema
  }

  return z.object(shape).strip() as z.ZodType<Record<string, unknown>>
}

function validatorForField(field: Field): z.ZodTypeAny {
  switch (field.kind) {
    case 'text': {
      let s = z.string()
      if (field.minLength !== undefined) s = s.min(field.minLength)
      if (field.maxLength !== undefined) s = s.max(field.maxLength)
      if (field.pattern) s = s.regex(new RegExp(field.pattern))
      return field.required ? s.min(Math.max(1, field.minLength ?? 1)) : s
    }
    case 'richtext':
      return z.string()
    case 'number': {
      let s = field.integer ? z.number().int() : z.number()
      if (field.min !== undefined) s = s.min(field.min)
      if (field.max !== undefined) s = s.max(field.max)
      return s
    }
    case 'boolean':
      return z.boolean()
    case 'date':
      return z.iso.datetime({ offset: true }).or(z.iso.date())
    case 'select': {
      // A creatable select is an open vocabulary: the declared options are only suggestions, so any
      // non-empty string is valid. A plain one is a closed enum. Either way `multiple` wraps it in
      // an array — a tag list is a creatable, multiple select.
      const values = field.options.map((o) => o.value) as [string, ...string[]]
      const one = field.creatable ? z.string().min(1) : z.enum(values)
      return field.multiple ? z.array(one) : one
    }
    case 'media': {
      const one = z.string().min(1)
      return field.multiple ? z.array(one) : one
    }
    case 'reference': {
      const one = z.string().min(1)
      return field.multiple ? z.array(one) : one
    }
    case 'url':
      return z.url()
    case 'email':
      return z.email()
    case 'color':
      // A hex colour, as a native `<input type="color">` produces.
      return z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex colour')
    case 'json':
      return z.unknown()
    case 'code':
      // Whatever the client sent is discarded before validation runs — the API assigns the value —
      // so this only has to accept the string the API itself put there.
      return z.string()
  }
}

/** The declared `code` fields of a collection, in declaration order. */
export function codeFields(fields: Field[]): Extract<Field, { kind: 'code' }>[] {
  return fields.filter((field): field is Extract<Field, { kind: 'code' }> => field.kind === 'code')
}

/** Renders one sequence number as this field's code — `RB-` + `7` at padding 4 is `RB-0007`. */
export function formatEntryCode(field: Extract<Field, { kind: 'code' }>, sequence: number): string {
  return `${field.prefix}${String(sequence).padStart(field.padding, '0')}`
}

/**
 * Reads the sequence back out of a code, so the next one can continue from the highest already
 * issued. Anything that is not this field's prefix followed by digits returns null — a code whose
 * prefix was changed after the fact is left alone rather than restarting the count from it.
 */
export function parseEntryCode(
  field: Extract<Field, { kind: 'code' }>,
  value: unknown,
): number | null {
  if (typeof value !== 'string' || !value.startsWith(field.prefix)) return null
  const digits = value.slice(field.prefix.length)
  if (!/^\d+$/.test(digits)) return null
  return Number.parseInt(digits, 10)
}

/** Sensible starting fields for a freshly created collection. */
export function defaultFields(): Field[] {
  return fieldsSchema.parse([
    { kind: 'text', name: 'title', label: 'Title', required: true, maxLength: 200 },
    { kind: 'richtext', name: 'body', label: 'Body', format: 'markdown' },
  ]) as Field[]
}
