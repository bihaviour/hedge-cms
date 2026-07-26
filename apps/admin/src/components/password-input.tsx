import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * A password field that can be read back.
 *
 * Every password in this admin is either being chosen (setup, invite, reset) or typed from a
 * manager into a login form, and both are places where a silent typo costs a round trip through
 * email. The toggle flips `type`, so the browser keeps autofilling and the value never leaves the
 * input — and it is a `button` with a label, so it is reachable without a mouse.
 */
export function PasswordInput({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, 'type'>) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        className={cn('pr-10', className)}
        // Never let a revealed password be corrected, completed or spoken by the browser.
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <button
        type="button"
        // Off the tab order: tabbing out of a password field should submit, not land here.
        tabIndex={-1}
        onClick={() => setVisible((shown) => !shown)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}
