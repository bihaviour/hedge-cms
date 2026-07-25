import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

/** Shared screen for the emailed invite and password-reset links — both just set a password. */
export function AcceptInvitePage({ mode = 'invite' }: { mode?: 'invite' | 'reset' }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const token = params.get('token') ?? ''

  /**
   * A member's link lands here only when their site has no domain of its own to host a reset page.
   * The token was issued by the member instance and is meaningless to the CMS one, so the marker
   * in the link is what decides where the password goes.
   */
  const forMember = mode === 'reset' && params.get('audience') === 'member'

  const submit = useMutation<unknown, Error, { token: string; password: string }>({
    mutationFn: (input) => {
      if (mode === 'invite') return api.auth.acceptInvite(input)
      return forMember ? api.member.resetPassword(input) : api.auth.resetPassword(input)
    },
    onSuccess: () => {
      queryClient.invalidateQueries()
      toast.success(mode === 'invite' ? 'Welcome aboard' : 'Password updated')
      // A member has no admin to be sent to — the CMS login would only refuse them.
      if (forMember) return
      navigate(mode === 'invite' ? '/collections' : '/login', { replace: true })
    },
  })

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {mode === 'invite' ? 'Accept your invite' : 'Choose a new password'}
          </CardTitle>
          <CardDescription>Pick a password of at least 12 characters.</CardDescription>
        </CardHeader>
        <CardContent>
          {submit.isSuccess && forMember ? (
            <p className="text-muted-foreground text-sm">
              Your password is set. You can sign in on the website now — this account is for reading
              members-only content, not for the CMS.
            </p>
          ) : token ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                submit.mutate({ token, password })
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  minLength={12}
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              {submit.error && (
                <p className="text-destructive text-sm">{(submit.error as Error).message}</p>
              )}

              <Button type="submit" className="w-full" disabled={submit.isPending}>
                Save password
              </Button>
            </form>
          ) : (
            <p className="text-muted-foreground text-sm">
              This link is missing its token. Ask an admin to send you a new one.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
