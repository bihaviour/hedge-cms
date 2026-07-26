import { cn } from '@/lib/utils'

/**
 * The product mark on the screens shown before there is a site to name — sign-in, setup, invite.
 * Set in type on purpose: a deployment that has not been branded yet still looks deliberate, and
 * replacing this with an image later is one component rather than four screens.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'text-center font-semibold text-lg tracking-[0.35em] text-foreground',
        className,
      )}
    >
      HEDGE
    </div>
  )
}
