import type { Field } from '@hedge/core'
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

/**
 * Renders the editor control for a single field definition. New field kinds only need a
 * case here plus a validator in `@hedge/core`.
 */
export function FieldInput({
  field,
  value,
  onChange,
  error,
}: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
  error?: string
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

      case 'select':
        if (field.multiple) {
          return (
            <Input
              id={id}
              placeholder="comma,separated,values"
              value={Array.isArray(value) ? value.join(',') : ''}
              onChange={(event) =>
                onChange(
                  event.target.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean),
                )
              }
            />
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
