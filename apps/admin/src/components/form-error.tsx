import { ApiClientError } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The whole of an API failure, not just its headline.
 *
 * A 400 from `validate()` always reads "Validation failed" — the useful part is in `details`,
 * keyed by field, and a form that renders only `error.message` throws it away and leaves the
 * person guessing which field it meant. Anything without details still shows its message.
 */
export function FormError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null

  const message = error instanceof Error ? error.message : 'Something went wrong'
  const details = error instanceof ApiClientError ? error.details : undefined
  const fields = details ? Object.entries(details) : []

  return (
    <div className={cn('space-y-1 text-destructive text-sm', className)} role="alert">
      <p>{message}</p>
      {fields.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {fields.map(([field, messages]) => (
            <li key={field}>
              {/* `_` is what the API uses for an issue about the body as a whole. */}
              {field !== '_' && <span className="font-medium">{labelFor(field)}: </span>}
              {messages.join(', ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** `defaultLocale` → `Default locale`, so the field name reads like the label above the input. */
function labelFor(field: string): string {
  const words = field
    .split('.')
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
