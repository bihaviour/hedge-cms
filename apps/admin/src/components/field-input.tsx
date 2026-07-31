import type { Field } from '@hedge/core'
import { ChevronLeft, ChevronRight, ImageIcon, Link2, Plus, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { EntryPicker } from '@/components/entry-picker'
import { MediaPicker } from '@/components/media-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { useMediaPreviewUrl } from '@/hooks/use-media-url'
import { type TranslateFn, useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

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
  locale = 'en',
}: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
  error?: string
  /** Extra values to offer as suggestions — e.g. values already used elsewhere in the collection. */
  suggestions?: string[]
  /** The locale of the entry being edited — a reference is picked from the same one. */
  locale?: string
}) {
  const id = `field-${field.name}`
  const t = useT()

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
        // Offer the declared options, whatever is already used elsewhere, and the current values —
        // but only on an open field. A closed one offers exactly what it accepts, or the list would
        // show rows that silently refuse to be picked.
        const hints = field.creatable
          ? unique([...optionValues, ...(suggestions ?? []), ...current])
          : unique([...optionValues, ...current])

        if (field.multiple) {
          return (
            <TagInput
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
        return <MediaField id={id} field={field} value={value} onChange={onChange} />

      case 'reference':
        return (
          <ReferenceField id={id} field={field} value={value} locale={locale} onChange={onChange} />
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

      case 'code':
        // Read-only by construction, not by a flag someone can flip: the API assigns this value on
        // the first save and discards whatever a client sends, so an editable box here would be a
        // control whose input is thrown away — worse than no control at all.
        return (
          <Input
            id={id}
            readOnly
            disabled
            className="font-mono"
            placeholder={t('editor.codeOnSave')}
            value={String(value ?? '')}
          />
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
 * The tag editor for a multiple `select` — a category or keyword list.
 *
 * This replaced a plain text input backed by a `<datalist>`. That combination is not a control: the
 * browser decides whether the suggestions appear at all, gives no way to see the vocabulary without
 * typing into it, offers no keyboard selection, and on several browsers hides the list entirely
 * once the box has text. For a field whose whole purpose is converging on a shared set of terms,
 * "you cannot see the set" is the wrong default, so the list is rendered here instead.
 *
 * `allowed`, when set, is the closed set of declared option values — anything else is refused, so a
 * non-creatable field can no longer submit a value its validator would reject. `null` means the
 * field is creatable: any non-empty string is accepted, and the suggestions are a convergent
 * vocabulary rather than a constraint.
 */
function TagInput({
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
  const t = useT()
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  // Which row Enter would take. Reset whenever the list it indexes into changes.
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const query = draft.trim().toLowerCase()
  const options = hints.filter(
    (hint) =>
      !values.includes(hint) &&
      (!query ||
        hint.toLowerCase().includes(query) ||
        labelFor(hint).toLowerCase().includes(query)),
  )
  // A creatable field offers the typed text as a new value, unless it is already on offer or held.
  const creating =
    !allowed && draft.trim() && ![...values, ...hints].some((v) => v.toLowerCase() === query)
      ? draft.trim()
      : null
  const rows: string[] = creating ? [creating, ...options] : options

  // Clicking away commits nothing and closes: a half-typed tag is not a tag.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function add(value: string) {
    setDraft('')
    setActive(0)
    if (!value) return
    // A closed set matches case-insensitively and stores the declared spelling, so "Engineering"
    // typed into a field declaring "engineering" lands on the option rather than being refused.
    const next = allowed
      ? allowed.find((option) => option.toLowerCase() === value.toLowerCase())
      : value
    if (!next || values.includes(next)) return
    onChange([...values, next])
  }

  return (
    <div ref={root} className="relative">
      {/* The whole box is the control: clicking anywhere in it puts the caret in the text input,
          which is what makes a row of chips behave like the single field it looks like. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 cursor-text"
        onClick={() => {
          input.current?.focus()
          setOpen(true)
        }}
      />
      <div className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
        {values.map((val) => (
          <Badge key={val} variant="secondary" className="relative gap-1 pr-1 font-normal">
            {labelFor(val)}
            <button
              type="button"
              aria-label={t('picker.removeItem', { label: labelFor(val) })}
              className="rounded-sm text-muted-foreground hover:text-foreground"
              onClick={() => onChange(values.filter((v) => v !== val))}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          className="relative min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          placeholder={values.length === 0 ? t('picker.tagsPlaceholder') : ''}
          value={draft}
          onFocus={() => setOpen(true)}
          // A row click can't blur this: those handlers preventDefault on mouse down. So a blur is
          // genuinely someone leaving the field, and the list should not follow them there.
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setDraft(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              if (rows.length === 0) return
              const delta = event.key === 'ArrowDown' ? 1 : -1
              setActive((current) => (current + delta + rows.length) % rows.length)
            } else if (event.key === 'Enter' || event.key === ',') {
              // Enter takes the highlighted row, or the typed text when there is no list to take
              // from. With neither it is left alone and the form gets it — a tag field should not
              // swallow the key that saves the entry just because the caret happens to be in it.
              const chosen = (open ? rows[active] : undefined) ?? draft.trim()
              if (!chosen) return
              event.preventDefault()
              add(chosen)
            } else if (event.key === 'Escape') {
              setOpen(false)
            } else if (event.key === 'Backspace' && !draft && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
        />
      </div>

      {open && (
        <div
          id={`${id}-listbox`}
          // A listbox rather than a <select>: a select cannot hold chips, a "create" row or free
          // text. The rows inside are the options, and the input above owns the focus throughout.
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {rows.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground text-sm">
              {hints.length === values.length ? t('picker.allTagsUsed') : t('picker.noMatch')}
            </p>
          )}
          {rows.map((row, index) => (
            <button
              key={row}
              type="button"
              role="option"
              aria-selected={index === active}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
              onMouseEnter={() => setActive(index)}
              // Mouse down rather than click: the input's blur would otherwise close the list
              // before the click landed.
              onMouseDown={(event) => {
                event.preventDefault()
                add(row)
                input.current?.focus()
              }}
            >
              {row === creating ? (
                <>
                  <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                  {t('picker.createTag', { value: row })}
                </>
              ) : (
                labelFor(row)
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The stored value of a `media` or `reference` field, as a list regardless of arity — one list to
 * add to, remove from and reorder, whatever shape it is written back in.
 */
function toValues(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

/**
 * Writes the value back in the shape `buildEntryValidator` expects: an array for a `multiple`
 * field, a plain string otherwise. The old input emitted a comma-joined string for both, so
 * declaring a multiple field and saving it failed validation — with the error attached to the
 * field rather than to the control that produced it. `packages/core/src/fields.test.ts` pins
 * both shapes, because this broke silently once and would break silently again.
 */
function emit(values: string[], multiple: boolean): unknown {
  if (multiple) return values
  return values[0] ?? null
}

function move(values: string[], from: number, to: number): string[] {
  const next = [...values]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** A picked media key or entry slug: what it is, and how to get rid of it or move it. */
function PickedItem({
  preview,
  label,
  sublabel,
  index,
  count,
  t,
  onMove,
  onRemove,
}: {
  preview: ReactNode
  label: string
  sublabel?: string
  index: number
  count: number
  t: TranslateFn
  onMove: (to: number) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border p-2">
      {preview}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{label}</p>
        {sublabel && <p className="truncate text-muted-foreground text-xs">{sublabel}</p>}
      </div>
      {count > 1 && (
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('picker.moveEarlier', { label })}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('picker.moveLater', { label })}
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('picker.removeItem', { label })}
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}

/**
 * The escape hatch. A picker that removes the ability to type a value outright is worse than the
 * text box was for anyone migrating content in, so the raw input stays — just out of the way.
 */
function RawValueInput({
  id,
  multiple,
  value,
  placeholder,
  onChange,
}: {
  id: string
  multiple: boolean
  value: string[]
  placeholder: string
  onChange: (values: string[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  if (!open) {
    return (
      <button
        type="button"
        className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        {t('picker.manual')}
      </button>
    )
  }

  // A single-value field binds straight to the stored value; a multiple one appends, so the
  // list stays a list instead of becoming the comma-joined string that broke before.
  if (!multiple) {
    return (
      <Input
        id={id}
        placeholder={placeholder}
        value={value[0] ?? ''}
        onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}
      />
    )
  }

  function add() {
    if (!draft.trim()) return
    onChange([...value, draft.trim()])
    setDraft('')
  }

  return (
    <div className="flex gap-2">
      <Input
        id={id}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          add()
        }}
      />
      <Button type="button" variant="outline" disabled={!draft.trim()} onClick={add}>
        <Plus className="size-4" />
        {t('picker.add')}
      </Button>
    </div>
  )
}

function MediaField({
  id,
  field,
  value,
  onChange,
}: {
  id: string
  field: Extract<Field, { kind: 'media' }>
  value: unknown
  onChange: (value: unknown) => void
}) {
  const t = useT()
  const previewUrl = useMediaPreviewUrl()
  const [picking, setPicking] = useState(false)
  const values = toValues(value)
  const set = (next: string[]) => onChange(emit(next, field.multiple))

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="space-y-2">
          {values.map((key, index) => {
            const src = previewUrl(key)
            return (
              <PickedItem
                key={key}
                index={index}
                count={values.length}
                t={t}
                label={key.split('/').pop() ?? key}
                sublabel={key}
                preview={
                  src ? (
                    <img
                      src={src}
                      alt=""
                      className="size-10 shrink-0 rounded bg-muted object-cover"
                      loading="lazy"
                      // A non-image, a typo or a deleted object: keep the row, drop the broken icon.
                      onError={(event) => {
                        event.currentTarget.style.visibility = 'hidden'
                      }}
                    />
                  ) : (
                    // A path into the website with no website URL recorded — the value is kept and
                    // still serves the site, there is just no origin here to render it from.
                    <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted">
                      <ImageIcon className="size-4 text-muted-foreground" />
                    </span>
                  )
                }
                onMove={(to) => set(move(values, index, to))}
                onRemove={() => set(values.filter((_, i) => i !== index))}
              />
            )
          })}
        </div>
      )}

      <div
        className={cn(
          'flex flex-wrap items-center gap-3',
          values.length === 0 &&
            'rounded-lg border border-dashed px-4 py-6 text-muted-foreground text-sm',
        )}
      >
        {values.length === 0 && (
          <span className="flex items-center gap-2">
            <ImageIcon className="size-4" />
            {t('picker.nothingChosen')}
          </span>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
          {values.length === 0 || field.multiple ? t('picker.chooseMedia') : t('picker.replace')}
        </Button>
        <RawValueInput
          id={id}
          multiple={field.multiple}
          value={values}
          placeholder={t('picker.mediaKeyPlaceholder')}
          onChange={set}
        />
      </div>

      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        multiple={field.multiple}
        accept={field.accept}
        onConfirm={(items) => {
          const keys = items.map((item) => item.key)
          set(field.multiple ? [...values, ...keys.filter((key) => !values.includes(key))] : keys)
        }}
      />
    </div>
  )
}

function ReferenceField({
  id,
  field,
  value,
  locale,
  onChange,
}: {
  id: string
  field: Extract<Field, { kind: 'reference' }>
  value: unknown
  locale: string
  onChange: (value: unknown) => void
}) {
  const t = useT()
  const [picking, setPicking] = useState(false)
  const values = toValues(value)
  const set = (next: string[]) => onChange(emit(next, field.multiple))

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="space-y-2">
          {values.map((slug, index) => (
            <PickedItem
              key={slug}
              index={index}
              count={values.length}
              t={t}
              label={slug}
              sublabel={t('picker.inCollection', { collection: field.collection })}
              preview={
                <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted">
                  <Link2 className="size-4 text-muted-foreground" />
                </span>
              }
              onMove={(to) => set(move(values, index, to))}
              onRemove={() => set(values.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      )}

      <div
        className={cn(
          'flex flex-wrap items-center gap-3',
          values.length === 0 &&
            'rounded-lg border border-dashed px-4 py-6 text-muted-foreground text-sm',
        )}
      >
        {values.length === 0 && (
          <span className="flex items-center gap-2">
            <Link2 className="size-4" />
            {t('picker.nothingLinked')}
          </span>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
          {values.length === 0 || field.multiple
            ? t('picker.chooseEntryAction')
            : t('picker.replace')}
        </Button>
        <RawValueInput
          id={id}
          multiple={field.multiple}
          value={values}
          placeholder={t('picker.entrySlugPlaceholder', { collection: field.collection })}
          onChange={set}
        />
      </div>

      <EntryPicker
        open={picking}
        onOpenChange={setPicking}
        collection={field.collection}
        locale={locale}
        multiple={field.multiple}
        onConfirm={(entries) => {
          const slugs = entries.map((entry) => entry.slug)
          set(
            field.multiple ? [...values, ...slugs.filter((slug) => !values.includes(slug))] : slugs,
          )
        }}
      />
    </div>
  )
}
