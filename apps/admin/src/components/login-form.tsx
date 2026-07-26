import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { FormError } from '@/components/form-error'
import { PasswordInput } from '@/components/password-input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Wordmark } from '@/components/wordmark'
import { useLogin } from '@/hooks/use-session'
import { api } from '@/lib/api'
import { pendingAuthorization, resumeAuthorization } from '@/lib/oauth'
import { cn } from '@/lib/utils'

/**
 * Sign-in for CMS users. Website members never come through here — they authenticate against
 * their own site with `POST /api/v1/member/login` and get a bearer token, not an admin session.
 */
export function LoginForm({ className, ...props }: React.ComponentProps<'div'>) {
  const login = useLogin()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [forgot, setForgot] = useState(false)

  const forgotPassword = useMutation({
    mutationFn: api.auth.forgotPassword,
    onSuccess: () => {
      toast.success('If that account exists, a reset link is on its way.')
      setForgot(false)
    },
  })

  const error = forgot ? forgotPassword.error : login.error
  const pending = forgot ? forgotPassword.isPending : login.isPending
  const authorizing = Boolean(pendingAuthorization())

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Wordmark />
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            {forgot ? 'Reset your password' : 'Welcome back'}
          </CardTitle>
          <CardDescription>
            {forgot
              ? 'We will email you a link to choose a new one.'
              : authorizing
                ? 'An application is waiting for you to sign in before it can ask for access.'
                : 'Sign in to your Hedge workspace'}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (forgot) forgotPassword.mutate({ email })
              // An MCP client may have sent the operator here mid-authorization; if so, signing in
              // hands them straight back to it rather than dropping them in the admin.
              else login.mutate({ email, password }, { onSuccess: () => resumeAuthorization() })
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>

              {!forgot && (
                <Field>
                  <div className="flex items-center">
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <button
                      type="button"
                      className="ml-auto text-sm underline-offset-4 hover:underline"
                      onClick={() => setForgot(true)}
                    >
                      Forgot your password?
                    </button>
                  </div>
                  <PasswordInput
                    id="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              )}

              <FormError error={error} />

              <Field>
                <Button type="submit" disabled={pending}>
                  {forgot ? 'Send reset link' : 'Sign in'}
                </Button>
                {forgot ? (
                  <FieldDescription className="text-center">
                    <button
                      type="button"
                      className="underline-offset-4 hover:underline"
                      onClick={() => setForgot(false)}
                    >
                      Back to sign in
                    </button>
                  </FieldDescription>
                ) : (
                  <FieldDescription className="text-center">
                    No account? An owner or admin has to invite you.
                  </FieldDescription>
                )}
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <FieldDescription className="px-6 text-center">
        Members of a website you publish sign in on that site, not here.
      </FieldDescription>
    </div>
  )
}
