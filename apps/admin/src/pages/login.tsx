import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLogin } from '@/hooks/use-session'
import { api } from '@/lib/api'

export function LoginPage() {
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

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{forgot ? 'Reset your password' : 'Sign in to Hedge'}</CardTitle>
          <CardDescription>
            {forgot
              ? 'We will email you a link to choose a new password.'
              : 'Enter your credentials to continue.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (forgot) forgotPassword.mutate({ email })
              else login.mutate({ email, password })
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            {!forgot && (
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            )}

            {login.error && (
              <p className="text-destructive text-sm">{(login.error as Error).message}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={login.isPending || forgotPassword.isPending}
            >
              {forgot ? 'Send reset link' : 'Sign in'}
            </Button>

            <button
              type="button"
              className="w-full text-muted-foreground text-sm hover:text-foreground"
              onClick={() => setForgot((value) => !value)}
            >
              {forgot ? 'Back to sign in' : 'Forgot your password?'}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
