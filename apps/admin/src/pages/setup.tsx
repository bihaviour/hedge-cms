import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

/** One-time screen shown while the instance has no users. Creates the owner account. */
export function SetupPage() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', email: '', password: '' })

  const setup = useMutation({
    mutationFn: api.auth.setup,
    onSuccess: (user) => {
      queryClient.setQueryData(['session'], user)
      queryClient.setQueryData(['setup-required'], { setupRequired: false })
    },
  })

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set up Hedge</CardTitle>
          <CardDescription>Create the owner account for this instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              setup.mutate(form)
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                minLength={12}
                required
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
              <p className="text-muted-foreground text-xs">At least 12 characters.</p>
            </div>

            {setup.error && (
              <p className="text-destructive text-sm">{(setup.error as Error).message}</p>
            )}

            <Button type="submit" className="w-full" disabled={setup.isPending}>
              Create account
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
