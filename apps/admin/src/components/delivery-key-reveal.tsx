import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/**
 * Shows a freshly issued `content:read` delivery key once, with a copy button and one line naming
 * what it is for. Used by the create-site flows (onboarding and the sites page) and the API-keys
 * backfill prompt — the key is stored hashed, so this is the only time its plaintext exists.
 */
export function DeliveryKeyReveal({ deliveryKey }: { deliveryKey: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">
          {deliveryKey}
        </code>
        <Button
          variant="outline"
          size="icon"
          aria-label="Copy delivery key"
          onClick={() => {
            navigator.clipboard.writeText(deliveryKey)
            toast.success('Copied to clipboard')
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Set this as <code className="font-mono">HEDGE_API_KEY</code> in your website's environment.
        It can read published content only (<code className="font-mono">content:read</code>), and
        this is the only time it is shown.
      </p>
    </div>
  )
}
