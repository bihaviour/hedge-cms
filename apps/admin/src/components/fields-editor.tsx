import { FIELD_KINDS, type Field, type FieldKind } from '@hedge/core'
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
      return { ...shared, kind, options: [{ value: 'option', label: 'Option' }], multiple: false }
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
  }
}
