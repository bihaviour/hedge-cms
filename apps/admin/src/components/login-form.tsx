import { LOGIN_CODE_LENGTH, type LoginResult, TRUSTED_DEVICE_TTL_DAYS } from '@hedge/core'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { FormError } from '@/components/form-error'
import { PasswordInput } from '@/components/password-input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Wordmark } from '@/components/wordmark'
import { useLogin, useVerifyLoginCode } from '@/hooks/use-session'
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
  /** Set when the password was right but this browser has to be verified first. */
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null)

  const forgotPassword = useMutation({
    mutationFn: api.auth.forgotPassword,
    onSuccess: () => {
      toast.success('If that account exists, a reset link is on its way.')
      setForgot(false)
    },
  })

  if (challenge) {
    return (
      <VerifyCodeForm
        className={className}
        challenge={challenge}
        onCancel={() => {
          setChallenge(null)
          setPassword('')
        }}
        {...props}
      />
    )
  }

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
              else
                login.mutate(
                  { email, password },
                  {
                    onSuccess: (result) => {
                      // A password alone does not finish a sign-in from an unrecognised browser —
                      // hand over to the code step rather than resuming anything.
                      if (result.verificationRequired) {
                        setChallenge(result)
                        return
                      }
                      // An MCP client may have sent the operator here mid-authorization; if so,
                      // signing in hands them straight back to it rather than dropping them in the
                      // admin.
                      resumeAuthorization()
                    },
                  },
                )
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

/** The `verificationRequired: true` arm of a login result — narrowed once, here. */
type PendingChallenge = Extract<LoginResult, { verificationRequired: true }>

/**
 * Step two: the code mailed because this browser is not one the account has been seen on.
 *
 * "Trust this browser" is off by default. Defaulting it on would make the check a one-time
 * formality on every machine an account touches, including shared and public ones, which is the
 * case it most needs to keep asking about.
 */
function VerifyCodeForm({
  challenge,
  onCancel,
  className,
  ...props
}: React.ComponentProps<'div'> & { challenge: PendingChallenge; onCancel: () => void }) {
  const verify = useVerifyLoginCode()
  const [code, setCode] = useState('')
  const [trustDevice, setTrustDevice] = useState(false)

  const resend = useMutation({
    mutationFn: api.auth.resendLoginCode,
    onSuccess: () => toast.success('A new code is on its way.'),
    onError: (error) => toast.error(error.message),
  })

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Wordmark />
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Check your email</CardTitle>
          <CardDescription>
            We don't recognise this browser, so we sent a {LOGIN_CODE_LENGTH}-digit code to{' '}
            <span className="font-medium">{challenge.maskedEmail}</span>.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              verify.mutate(
                { challengeId: challenge.challengeId, code, trustDevice },
                { onSuccess: () => resumeAuthorization() },
              )
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="code">Verification code</FieldLabel>
                <Input
                  id="code"
                  // `one-time-code` is what lets iOS and Android offer the code from the
                  // notification, which is most of why people tolerate this step at all.
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={LOGIN_CODE_LENGTH}
                  required
                  autoFocus
                  placeholder="123456"
                  className="text-center font-mono text-lg tracking-[0.4em]"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
              </Field>

              {/* The hint is a sibling of the label rather than a child of it: `Label` is a flex
                  container, so nesting the two would lay them out side by side. */}
              <div className="flex items-start justify-between gap-3 text-sm">
                <div className="space-y-1">
                  <Label htmlFor="trust-device" className="font-normal">
                    Trust this browser for {TRUSTED_DEVICE_TTL_DAYS} days
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    Leave this off on a shared or public computer.
                  </p>
                </div>
                <Switch id="trust-device" checked={trustDevice} onCheckedChange={setTrustDevice} />
              </div>

              <FormError error={verify.error} />

              <Field>
                <Button
                  type="submit"
                  disabled={verify.isPending || code.length < LOGIN_CODE_LENGTH}
                >
                  Verify and sign in
                </Button>
                <FieldDescription className="text-center">
                  <button
                    type="button"
                    className="underline-offset-4 hover:underline"
                    disabled={resend.isPending}
                    onClick={() => resend.mutate({ challengeId: challenge.challengeId })}
                  >
                    Send a new code
                  </button>
                  {' · '}
                  <button
                    type="button"
                    className="underline-offset-4 hover:underline"
                    onClick={onCancel}
                  >
                    Back to sign in
                  </button>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <FieldDescription className="px-6 text-center">
        Didn't try to sign in? Someone else knows your password — reset it from the sign-in screen.
      </FieldDescription>
    </div>
  )
}
