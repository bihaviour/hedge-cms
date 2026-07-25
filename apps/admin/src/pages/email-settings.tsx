import type { EmailConfig } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'

interface Form {
  fromEmail: string
  fromName: string
  replyTo: string
  enabled: boolean
}

function toForm(config: EmailConfig): Form {
  return {
    fromEmail: config.fromEmail ?? '',
    fromName: config.fromName ?? '',
    replyTo: config.replyTo ?? '',
    enabled: config.enabled,
  }
}

export function EmailSettingsPage() {
  const queryClient = useQueryClient()
  const config = useQuery({ queryKey: ['email-config'], queryFn: api.email.config })
  const [form, setForm] = useState<Form | null>(null)

  useEffect(() => {
    if (config.data) setForm(toForm(config.data))
  }, [config.data])

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('Not loaded')
      // Empty strings are cleared overrides, sent as null so the deployment default applies again.
      return api.email.updateConfig({
        fromEmail: form.fromEmail.trim() || null,
        fromName: form.fromName.trim() || null,
        replyTo: form.replyTo.trim() || null,
        enabled: form.enabled,
      })
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['email-config'], updated)
      toast.success('Email settings saved')
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title="Email settings"
        description="Sender identity and delivery for the Cloudflare Email binding. Overrides sit on top of the deployment defaults."
      />

      <div className="max-w-2xl p-8">
        {config.isLoading || !form ? (
          <Skeleton className="h-80 w-full" />
        ) : (
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate()
            }}
          >
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="email-enabled">Sending enabled</Label>
                <p className="text-muted-foreground text-sm">
                  When off, Hedge still composes and logs emails but never hands them to the
                  provider.
                </p>
              </div>
              <Switch
                id="email-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm((f) => f && { ...f, enabled: checked })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="from-email">From address</Label>
              <Input
                id="from-email"
                type="email"
                placeholder={config.data?.defaultFromEmail}
                value={form.fromEmail}
                onChange={(event) => setForm((f) => f && { ...f, fromEmail: event.target.value })}
              />
              <p className="text-muted-foreground text-xs">
                Must be on a domain onboarded with Cloudflare Email Sending. Leave blank to use{' '}
                <span className="font-medium">{config.data?.defaultFromEmail}</span>.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="from-name">From name</Label>
              <Input
                id="from-name"
                placeholder={config.data?.defaultFromName}
                value={form.fromName}
                onChange={(event) => setForm((f) => f && { ...f, fromName: event.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="reply-to">Reply-to address</Label>
              <Input
                id="reply-to"
                type="email"
                placeholder="No reply-to"
                value={form.replyTo}
                onChange={(event) => setForm((f) => f && { ...f, replyTo: event.target.value })}
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={save.isPending}>
                Save settings
              </Button>
            </div>
          </form>
        )}
      </div>
    </>
  )
}
