import { slugify } from '@hedge/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { FormError } from '@/components/form-error'
import { PasswordInput } from '@/components/password-input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Wordmark } from '@/components/wordmark'
import { setActiveSite } from '@/lib/active-site'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const STEPS = ['Your account', 'Your first site'] as const

/**
 * First-run wizard: the owner account, then the first site.
 *
 * The two are separate steps rather than one form because they are separate things to get right —
 * and because the account is created the moment step one is submitted, so an interrupted setup is
 * resumed by signing in rather than started over. `step` is derived from what exists, not
 * remembered: whoever lands here with an account but no site is sent straight to step two.
 */
export function OnboardingPage({ hasAccount }: { hasAccount: boolean }) {
  const step = hasAccount ? 1 : 0

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <Wordmark />
        <Steps current={step} />
        {step === 0 ? <AccountStep /> : <SiteStep />}
      </div>
    </div>
  )
}

function Steps({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-3">
      {STEPS.map((label, index) => (
        <li key={label} className="flex flex-1 items-center gap-2">
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
              index < current && 'border-primary bg-primary text-primary-foreground',
              index === current && 'border-primary text-primary',
              index > current && 'text-muted-foreground',
            )}
          >
            {index < current ? <Check className="size-3.5" /> : index + 1}
          </span>
          <span
            className={cn(
              'truncate text-sm',
              index === current ? 'font-medium' : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function AccountStep() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', email: '', password: '' })

  const setup = useMutation({
    mutationFn: api.auth.setup,
    onSuccess: (user) => {
      queryClient.setQueryData(['session'], user)
      queryClient.setQueryData(['setup-required'], { setupRequired: false })
      queryClient.invalidateQueries({ queryKey: ['sites'] })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up Hedge</CardTitle>
        <CardDescription>
          This account owns the deployment — it can never be deleted or demoted, and everyone else
          joins by invitation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setup.mutate(form)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Your name</FieldLabel>
              <Input
                id="name"
                required
                autoFocus
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <PasswordInput
                id="password"
                minLength={12}
                required
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
              <FieldDescription>At least 12 characters.</FieldDescription>
            </Field>

            <FormError error={setup.error} />

            <Field>
              <Button type="submit" className="w-full" disabled={setup.isPending}>
                Create account
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * A site is the tenant everything else hangs off — collections, media, API keys, members — so
 * there is no usable CMS until one exists. That is why this step cannot be skipped.
 */
function SiteStep() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', slug: '', domain: '', allowMemberSignup: true })

  const create = useMutation({
    mutationFn: api.sites.create,
    onSuccess: async (site) => {
      // Land in the site that was just made, rather than whatever the last browser remembered.
      setActiveSite(site.slug)
      await queryClient.invalidateQueries()
      navigate('/collections', { replace: true })
    },
  })

  const slug = form.slug || slugify(form.name)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your first site</CardTitle>
        <CardDescription>
          One deployment holds many sites — a blog, a docs site, a landing page. Each keeps its own
          content, media, keys and members. You can add more later.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate({
              name: form.name,
              slug,
              domain: form.domain || null,
              allowMemberSignup: form.allowMemberSignup,
              // English on the browser's timezone to start; refine it under Sites → Localization.
              locales: ['en'],
              defaultLocale: 'en',
              timezone: (() => {
                try {
                  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
                } catch {
                  return 'UTC'
                }
              })(),
            })
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="site-name">Name</FieldLabel>
              <Input
                id="site-name"
                required
                autoFocus
                placeholder="My blog"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="site-slug">Slug</FieldLabel>
              <Input
                id="site-slug"
                value={form.slug}
                placeholder={slugify(form.name) || 'my-blog'}
                onChange={(event) => setForm({ ...form, slug: slugify(event.target.value) })}
              />
              <FieldDescription>
                Sent as the <code>X-Hedge-Site</code> header to pick this site.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="site-domain">Domain (optional)</FieldLabel>
              <Input
                id="site-domain"
                placeholder="blog.example.com"
                value={form.domain}
                onChange={(event) => setForm({ ...form, domain: event.target.value.trim() })}
              />
              <FieldDescription>
                Requests arriving on this hostname resolve to this site, and member emails link back
                to it.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="site-signup">Let visitors sign up as members</FieldLabel>
                <FieldDescription>
                  Off makes the site invite-only — members can then only be added from the admin.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="site-signup"
                checked={form.allowMemberSignup}
                onCheckedChange={(allowMemberSignup) => setForm({ ...form, allowMemberSignup })}
              />
            </Field>

            <FormError error={create.error} />

            <Field>
              <Button
                type="submit"
                className="w-full"
                disabled={create.isPending || !form.name || !slug}
              >
                Create site and finish
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
