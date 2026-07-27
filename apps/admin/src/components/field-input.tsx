import type { Field } from '@hedge/core'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

const unique = (values: string[]) => [...new Set(values)]

/**
 * Renders the editor control for a single field definition. New field kinds only need a
 * case here plus a validator in `@hedge/core`.
 */
export function FieldInput({
  field,
  value,
  onChange,
  error,
  suggestions,
}: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
  error?: string
  /** Extra values to offer as suggestions — e.g. values already used elsewhere in the collection. */
  suggestions?: string[]
}) {
  const id = `field-${field.name}`

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>

      {renderControl()}

      {field.description && <p className="text-muted-foreground text-xs">{field.description}</p>}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )

  function renderControl() {
    switch (field.kind) {
      case 'text':
        return field.multiline ? (
          <Textarea
            id={id}
            rows={3}
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <Input
            id={id}
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
        )

      case 'richtext':
        return (
          <Textarea
            id={id}
            rows={14}
            className="font-mono text-sm"
            placeholder={field.format === 'markdown' ? '# Markdown supported' : '<p>HTML</p>'}
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
        )

      case 'number':
        return (
          <Input
            id={id}
            type="number"
            step={field.integer ? 1 : 'any'}
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(event) =>
              onChange(event.target.value === '' ? null : Number(event.target.value))
            }
          />
        )

      case 'boolean':
        return (
          <div className="flex h-9 items-center">
            <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} />
          </div>
        )

      case 'date':
        return (
          <Input
            id={id}
            type={field.includeTime ? 'datetime-local' : 'date'}
            value={toDateInputValue(value, field.includeTime)}
            onChange={(event) =>
              onChange(
                event.target.value === ''
                  ? null
                  : field.includeTime
                    ? new Date(event.target.value).toISOString()
                    : event.target.value,
              )
            }
          />
        )

      case 'select': {
        const optionValues = field.options.map((option) => option.value)
        const labelFor = (val: string) =>
          field.options.find((option) => option.value === val)?.label ?? val
        const current = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : []
        // Offer the declared options, whatever is already used elsewhere, and the current values.
        const hints = unique([...optionValues, ...(suggestions ?? []), ...current])

        if (field.multiple) {
          return (
            <TokenInput
              id={id}
              values={current}
              hints={hints}
              labelFor={labelFor}
              // A non-creatable field is a closed set: the input accepts only its declared options,
              // so the form can no longer submit a value the API would reject.
              allowed={field.creatable ? null : optionValues}
              onChange={onChange}
            />
          )
        }

        // An open single-value select is a free text box with the options as suggestions; a closed
        // one stays a dropdown that cannot express an invalid value in the first place.
        if (field.creatable) {
          return (
            <>
              <Input
                id={id}
                list={`${id}-list`}
                value={String(value ?? '')}
                onChange={(event) => onChange(event.target.value)}
              />
              <datalist id={`${id}-list`}>
                {hints.map((hint) => (
                  <option key={hint} value={hint}>
                    {labelFor(hint)}
                  </option>
                ))}
              </datalist>
            </>
          )
        }
        return (
          <Select value={String(value ?? '')} onValueChange={onChange}>
            <SelectTrigger id={id}>
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {field.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }

      case 'media':
        return (
          <Input
            id={id}
            placeholder="Media key, e.g. 2026/07/abc-photo.jpg"
            value={Array.isArray(value) ? value.join(',') : String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
        )

      case 'reference':
        return (
          <Input
            id={id}
            placeholder={`Entry slug in "${field.collection}"`}
            value={Array.isArray(value) ? value.join(',') : String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
        )

      case 'url':
        return (
          <Input
            id={id}
            type="url"
            inputMode="url"
            placeholder="https://example.com"
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
        )

      case 'email':
        return (
          <Input
            id={id}
            type="email"
            inputMode="email"
            placeholder="name@example.com"
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
        )

      case 'color':
        return (
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="color"
              className="h-9 w-14 p-1"
              value={/^#[0-9a-fA-F]{6}$/.test(String(value)) ? String(value) : '#000000'}
              onChange={(event) => onChange(event.target.value)}
            />
            <Input
              aria-label={`${field.label} hex value`}
              className="font-mono"
              placeholder="#000000"
              value={String(value ?? '')}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
        )

      case 'json':
        return (
          <Textarea
            id={id}
            rows={6}
            className="font-mono text-sm"
            value={value === undefined ? '' : JSON.stringify(value, null, 2)}
            onChange={(event) => {
              try {
                onChange(JSON.parse(event.target.value))
              } catch {
                // Keep the raw text so the user can finish typing; validation runs on save.
                onChange(event.target.value)
              }
            }}
          />
        )
    }
  }
}

function toDateInputValue(value: unknown, includeTime: boolean): string {
  if (typeof value !== 'string' || !value) return ''
  return includeTime ? value.slice(0, 16) : value.slice(0, 10)
}

/**
 * A chip/token editor for a multiple `select`. Existing values render as removable chips; typing
 * filters the suggestions and Enter (or a comma) commits. `allowed`, when set, is the closed set of
 * declared option values — anything else is refused in the input, so a non-creatable field can no
 * longer submit a value its validator would reject. `null` means the field is creatable: any
 * non-empty string is accepted, with the suggestions offered as a convergent vocabulary rather than
 * a constraint.
 */
function TokenInput({
  id,
  values,
  hints,
  labelFor,
  allowed,
  onChange,
}: {
  id: string
  values: string[]
  hints: string[]
  labelFor: (value: string) => string
  allowed: string[] | null
  onChange: (values: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const listId = `${id}-list`

  function commit(raw: string) {
    const text = raw.trim()
    setDraft('')
    if (!text) return
    let next = text
    if (allowed) {
      // Match a declared option case-insensitively and store its canonical value; refuse the rest.
      const match = allowed.find((option) => option.toLowerCase() === text.toLowerCase())
      if (!match) return
      next = match
    }
    if (!values.includes(next)) onChange([...values, next])
  }

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((val) => (
            <Badge key={val} variant="secondary" className="gap-1 pr-1 font-normal">
              {labelFor(val)}
              <button
                type="button"
                aria-label={`Remove ${labelFor(val)}`}
                className="rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() => onChange(values.filter((v) => v !== val))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        id={id}
        list={listId}
        placeholder={allowed ? 'Choose a value…' : 'Type a value and press Enter'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            commit(draft)
          } else if (event.key === 'Backspace' && !draft && values.length > 0) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={() => commit(draft)}
      />
      <datalist id={listId}>
        {hints
          .filter((hint) => !values.includes(hint))
          .map((hint) => (
            <option key={hint} value={hint}>
              {labelFor(hint)}
            </option>
          ))}
      </datalist>
    </div>
  )
}
