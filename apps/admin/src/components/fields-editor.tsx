import { FIELD_KINDS, type Field, type FieldKind } from '@hedge/core'

/** The `select` member of the field union — the one kind with editable options and flags. */
type SelectField = Extract<Field, { kind: 'select' }>
type MediaField = Extract<Field, { kind: 'media' }>
type ReferenceField = Extract<Field, { kind: 'reference' }>
type CodeField = Extract<Field, { kind: 'code' }>

import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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

/**
 * A single editable field definition. Each row carries a stable `key` so React keeps input focus
 * and cursor state across reorders and renames — the field's own `name` is user-editable and so
 * cannot double as the key.
 */
export interface FieldRow {
  key: string
  field: Field
}

let nextKey = 0

/** Wrap field definitions in rows with fresh stable keys — used when seeding the editor from data. */
export function toFieldRows(fields: Field[]): FieldRow[] {
  return fields.map((field) => ({ key: `field-${nextKey++}`, field }))
}

/**
 * The field-schema editor, shared by the collection settings page and the site custom-fields page.
 * Fully controlled: the parent owns the rows and persists them. Reordering here is meaningful — it
 * is the order the fields appear in the entry form.
 */
export function FieldsEditor({
  rows,
  onChange,
  addLabel = 'Add field',
}: {
  rows: FieldRow[]
  onChange: (rows: FieldRow[]) => void
  addLabel?: string
}) {
  function updateField(index: number, patch: Partial<Field>) {
    onChange(
      rows.map((row, i) =>
        i === index ? { ...row, field: { ...row.field, ...patch } as Field } : row,
      ),
    )
  }

  // Select carries config the shared `updateField` can't type — `options` and the two flags only
  // exist on this kind — so it gets its own narrowed updater.
  function updateSelect(index: number, patch: Partial<SelectField>) {
    onChange(
      rows.map((row, i) =>
        i === index && row.field.kind === 'select'
          ? { ...row, field: { ...row.field, ...patch } }
          : row,
      ),
    )
  }

  /** Same narrowing for the two kinds that point at something outside themselves. */
  function updateMedia(index: number, patch: Partial<MediaField>) {
    onChange(
      rows.map((row, i) =>
        i === index && row.field.kind === 'media'
          ? { ...row, field: { ...row.field, ...patch } }
          : row,
      ),
    )
  }

  function updateReference(index: number, patch: Partial<ReferenceField>) {
    onChange(
      rows.map((row, i) =>
        i === index && row.field.kind === 'reference'
          ? { ...row, field: { ...row.field, ...patch } }
          : row,
      ),
    )
  }

  function updateCode(index: number, patch: Partial<CodeField>) {
    onChange(
      rows.map((row, i) =>
        i === index && row.field.kind === 'code'
          ? { ...row, field: { ...row.field, ...patch } }
          : row,
      ),
    )
  }

  function move(index: number, delta: number) {
    const next = [...rows]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {rows.map(({ key, field }, index) => (
        <Card key={key}>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-start gap-3">
              <div className="flex flex-col pt-2">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Move field up"
                  onClick={() => move(index, -1)}
                >
                  <GripVertical className="size-4" />
                </button>
              </div>

              <div className="grid flex-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Label</Label>
                  <Input
                    value={field.label}
                    onChange={(event) => updateField(index, { label: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">API name</Label>
                  <Input
                    value={field.name}
                    onChange={(event) =>
                      updateField(index, {
                        name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={field.kind}
                    onValueChange={(value) =>
                      onChange(
                        rows.map((row, i) =>
                          i === index
                            ? { ...row, field: blankField(value as FieldKind, row.field) }
                            : row,
                        ),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind} className="capitalize">
                          {kind}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove field"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div className="flex items-center gap-6 pl-7">
              <div className="flex items-center gap-2">
                <Switch
                  id={`${key}-required`}
                  checked={field.required}
                  onCheckedChange={(checked) => updateField(index, { required: checked })}
                />
                <Label htmlFor={`${key}-required`} className="text-sm font-normal">
                  Required
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id={`${key}-localized`}
                  checked={field.localized}
                  onCheckedChange={(checked) => updateField(index, { localized: checked })}
                />
                <Label htmlFor={`${key}-localized`} className="text-sm font-normal">
                  Localized
                </Label>
              </div>
            </div>

            {field.kind === 'select' && (
              <SelectConfig
                fieldKey={key}
                field={field}
                onPatch={(patch) => updateSelect(index, patch)}
              />
            )}

            {field.kind === 'media' && (
              <MediaConfig
                fieldKey={key}
                field={field}
                onPatch={(patch) => updateMedia(index, patch)}
              />
            )}

            {field.kind === 'reference' && (
              <ReferenceConfig
                fieldKey={key}
                field={field}
                onPatch={(patch) => updateReference(index, patch)}
              />
            )}

            {field.kind === 'code' && (
              <CodeConfig
                fieldKey={key}
                field={field}
                onPatch={(patch) => updateCode(index, patch)}
              />
            )}
          </CardContent>
        </Card>
      ))}

      <Button
        variant="outline"
        onClick={() =>
          onChange([
            ...rows,
            {
              key: `field-${nextKey++}`,
              field: blankField('text', {
                name: `field_${rows.length + 1}`,
                label: `Field ${rows.length + 1}`,
              }),
            },
          ])
        }
      >
        <Plus className="size-4" />
        {addLabel}
      </Button>
    </div>
  )
}

/**
 * The extra configuration a `select` needs: whether it takes multiple values, whether new values
 * can be created beyond the declared list (turning the options into suggestions), and the options
 * themselves. `creatable` is what makes a `select` usable as a free-form tag field.
 */
function SelectConfig({
  fieldKey,
  field,
  onPatch,
}: {
  fieldKey: string
  field: SelectField
  onPatch: (patch: Partial<SelectField>) => void
}) {
  function updateOption(index: number, patch: Partial<SelectField['options'][number]>) {
    onPatch({
      options: field.options.map((option, i) => (i === index ? { ...option, ...patch } : option)),
    })
  }

  return (
    <div className="space-y-3 border-t pt-4 pl-7">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <Switch
            id={`${fieldKey}-multiple`}
            checked={field.multiple}
            onCheckedChange={(checked) => onPatch({ multiple: checked })}
          />
          <Label htmlFor={`${fieldKey}-multiple`} className="text-sm font-normal">
            Allow multiple
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${fieldKey}-creatable`}
            checked={field.creatable}
            onCheckedChange={(checked) => onPatch({ creatable: checked })}
          />
          <Label htmlFor={`${fieldKey}-creatable`} className="text-sm font-normal">
            Allow new values
          </Label>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{field.creatable ? 'Suggested values' : 'Options'}</Label>
        {field.options.map((option, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: options have no stable id and this short list is edited in place, never reordered
          <div key={index} className="flex items-center gap-2">
            <Input
              className="h-8"
              placeholder="value"
              value={option.value}
              onChange={(event) => updateOption(index, { value: event.target.value })}
            />
            <Input
              className="h-8"
              placeholder="label"
              value={option.label}
              onChange={(event) => updateOption(index, { label: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove option"
              disabled={field.options.length <= 1}
              onClick={() => onPatch({ options: field.options.filter((_, i) => i !== index) })}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPatch({ options: [...field.options, { value: '', label: '' }] })}
        >
          <Plus className="size-4" />
          Add option
        </Button>
      </div>
    </div>
  )
}

/** Builds a field of the requested kind, carrying over the name/label/flags that all kinds share. */
export function blankField(
  kind: FieldKind,
  base: { name: string; label: string; required?: boolean; localized?: boolean },
): Field {
  const shared = {
    name: base.name,
    label: base.label,
    required: base.required ?? false,
    localized: base.localized ?? false,
  }

  switch (kind) {
    case 'text':
      return { ...shared, kind, multiline: false }
    case 'richtext':
      return { ...shared, kind, format: 'markdown' }
    case 'number':
      return { ...shared, kind, integer: false }
    case 'boolean':
      return { ...shared, kind }
    case 'date':
      return { ...shared, kind, includeTime: true }
    case 'select':
      return {
        ...shared,
        kind,
        options: [{ value: 'option', label: 'Option' }],
        multiple: false,
        creatable: false,
      }
    case 'media':
      return { ...shared, kind, accept: [], multiple: false }
    case 'reference':
      return { ...shared, kind, collection: '', multiple: false }
    case 'url':
      return { ...shared, kind }
    case 'email':
      return { ...shared, kind }
    case 'color':
      return { ...shared, kind }
    case 'json':
      return { ...shared, kind }
    case 'code':
      return { ...shared, kind, prefix: '', padding: 4 }
  }
}

/**
 * A `code` field's shape. There is nothing here about *whether* it is generated — it always is,
 * which is the point of the kind — only what the generated value looks like.
 */
function CodeConfig({
  fieldKey,
  field,
  onPatch,
}: {
  fieldKey: string
  field: CodeField
  onPatch: (patch: Partial<CodeField>) => void
}) {
  return (
    <div className="space-y-3 border-t pt-4 pl-7">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={`${fieldKey}-prefix`}>
            Prefix
          </Label>
          <Input
            id={`${fieldKey}-prefix`}
            className="h-8"
            placeholder="RB-"
            maxLength={16}
            value={field.prefix}
            onChange={(event) => onPatch({ prefix: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={`${fieldKey}-padding`}>
            Digits
          </Label>
          <Input
            id={`${fieldKey}-padding`}
            className="h-8"
            type="number"
            min={1}
            max={12}
            value={field.padding}
            onChange={(event) => onPatch({ padding: Number(event.target.value) || 1 })}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Assigned by Hedge when an entry is first created, and never editable — the next one here
        would be <code>{`${field.prefix}${'1'.padStart(field.padding, '0')}`}</code>. Changing the
        prefix or digits only affects codes issued from now on.
      </p>
    </div>
  )
}

/**
 * What a `media` field accepts, and whether it holds several. Both options existed on the schema
 * from the start and neither could be set here, so `accept` was declared-and-ignored in practice
 * and a multiple media field could only be created through the API.
 */
function MediaConfig({
  fieldKey,
  field,
  onPatch,
}: {
  fieldKey: string
  field: MediaField
  onPatch: (patch: Partial<MediaField>) => void
}) {
  return (
    <div className="grid gap-3 border-t pt-4 pl-7 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor={`${fieldKey}-accept`}>
          Accepted file types
        </Label>
        <Input
          id={`${fieldKey}-accept`}
          placeholder="image/* — leave empty for anything"
          value={field.accept.join(', ')}
          onChange={(event) =>
            onPatch({
              accept: event.target.value
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
      <div className="flex items-center gap-2 sm:pt-6">
        <Switch
          id={`${fieldKey}-multiple`}
          checked={field.multiple}
          onCheckedChange={(checked) => onPatch({ multiple: checked })}
        />
        <Label htmlFor={`${fieldKey}-multiple`} className="font-normal text-sm">
          Allow multiple
        </Label>
      </div>
    </div>
  )
}

/**
 * Which collection a `reference` points at. This is required by the schema (`min(1)`), so before
 * it was editable here a reference field created in this editor could not be saved at all.
 */
function ReferenceConfig({
  fieldKey,
  field,
  onPatch,
}: {
  fieldKey: string
  field: ReferenceField
  onPatch: (patch: Partial<ReferenceField>) => void
}) {
  return (
    <div className="grid gap-3 border-t pt-4 pl-7 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor={`${fieldKey}-collection`}>
          Links to collection
        </Label>
        <Input
          id={`${fieldKey}-collection`}
          placeholder="posts"
          value={field.collection}
          onChange={(event) => onPatch({ collection: event.target.value })}
        />
      </div>
      <div className="flex items-center gap-2 sm:pt-6">
        <Switch
          id={`${fieldKey}-multiple`}
          checked={field.multiple}
          onCheckedChange={(checked) => onPatch({ multiple: checked })}
        />
        <Label htmlFor={`${fieldKey}-multiple`} className="font-normal text-sm">
          Allow multiple
        </Label>
      </div>
    </div>
  )
}
