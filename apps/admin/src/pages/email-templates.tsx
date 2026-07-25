import type { EmailTemplate } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

export function EmailTemplatesPage() {
  const [editing, setEditing] = useState<EmailTemplate | null>(null)

  const templates = useQuery({ queryKey: ['email-templates'], queryFn: api.email.templates })

  return (
    <>
      <PageHeader
        title="Email templates"
        description="Customize the system emails Hedge sends. Unedited templates fall back to the built-in default."
      />

      <div className="p-8">
        {templates.isLoading && <Skeleton className="h-64 w-full" />}

        {templates.data && templates.data.length === 0 && (
          <EmptyState title="No templates" description="No system emails are configured." />
        )}

        {templates.data && templates.data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {templates.data.map((template) => (
              <button
                type="button"
                key={template.key}
                onClick={() => setEditing(template)}
                className="flex flex-col items-start gap-2 rounded-lg border p-5 text-left transition-colors hover:bg-accent"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-medium">
                    <Mail className="size-4 text-muted-foreground" />
                    {template.label}
                  </div>
                  {template.customized ? (
                    <Badge variant="secondary">Customized</Badge>
                  ) : (
                    <Badge variant="outline">Default</Badge>
                  )}
                </div>
                <p className="text-muted-foreground text-sm">{template.description}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  Subject: <span className="font-medium">{template.subject}</span>
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      <TemplateEditor template={editing} onClose={() => setEditing(null)} />
    </>
  )
}

interface Draft {
  subject: string
  heading: string
  body: string
  ctaLabel: string
}

function TemplateEditor({
  template,
  onClose,
}: {
  template: EmailTemplate | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>({ subject: '', heading: '', body: '', ctaLabel: '' })

  // Seed the form each time a different template is opened.
  useEffect(() => {
    if (template) {
      setDraft({
        subject: template.subject,
        heading: template.heading,
        body: template.body,
        ctaLabel: template.ctaLabel ?? '',
      })
    }
  }, [template])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['email-templates'] })
  }

  const save = useMutation({
    mutationFn: () => {
      if (!template) throw new Error('No template')
      return api.email.updateTemplate(template.key, toInput(draft))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Template saved')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  const reset = useMutation({
    mutationFn: () => {
      if (!template) throw new Error('No template')
      return api.email.resetTemplate(template.key)
    },
    onSuccess: () => {
      invalidate()
      toast.success('Reset to default')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Sheet open={template !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{template?.label}</SheetTitle>
          <SheetDescription>
            {template?.description} Use{' '}
            {template?.variables.map((variable, index) => (
              <span key={variable}>
                {index > 0 && ', '}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">{`{{${variable}}}`}</code>
              </span>
            ))}{' '}
            as placeholders.
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex flex-1 flex-col gap-5 px-4 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="tpl-subject">Subject</Label>
            <Input
              id="tpl-subject"
              required
              value={draft.subject}
              onChange={(event) => setDraft((d) => ({ ...d, subject: event.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-heading">Heading</Label>
            <Input
              id="tpl-heading"
              required
              value={draft.heading}
              onChange={(event) => setDraft((d) => ({ ...d, heading: event.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-body">Body</Label>
            <Textarea
              id="tpl-body"
              required
              rows={5}
              value={draft.body}
              onChange={(event) => setDraft((d) => ({ ...d, body: event.target.value }))}
            />
            <p className="text-muted-foreground text-xs">HTML is allowed in the body.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-cta">Button label</Label>
            <Input
              id="tpl-cta"
              placeholder="No button"
              value={draft.ctaLabel}
              onChange={(event) => setDraft((d) => ({ ...d, ctaLabel: event.target.value }))}
            />
          </div>

          {template && <TemplatePreview templateKey={template.key} draft={draft} />}
        </form>

        <SheetFooter className="flex-row justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!template?.customized || reset.isPending}
            onClick={() => reset.mutate()}
          >
            <RotateCcw className="size-4" />
            Reset to default
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function toInput(draft: Draft) {
  return {
    subject: draft.subject,
    heading: draft.heading,
    body: draft.body,
    ctaLabel: draft.ctaLabel.trim() ? draft.ctaLabel : null,
  }
}

/** A live rendering of the current draft, refreshed shortly after the operator stops typing. */
function TemplatePreview({
  templateKey,
  draft,
}: {
  templateKey: EmailTemplate['key']
  draft: Draft
}) {
  const [debounced, setDebounced] = useState(draft)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(draft), 400)
    return () => clearTimeout(timer)
  }, [draft])

  const preview = useQuery({
    queryKey: ['email-preview', templateKey, debounced],
    queryFn: () => api.email.previewTemplate(templateKey, toInput(debounced)),
    enabled: Boolean(debounced.subject && debounced.heading && debounced.body),
  })

  return (
    <div className="space-y-2">
      <Label>Preview</Label>
      <div className="overflow-hidden rounded-lg border bg-muted/30">
        {preview.data ? (
          <iframe
            title="Email preview"
            className="h-80 w-full bg-white"
            sandbox=""
            srcDoc={preview.data.html}
          />
        ) : (
          <Skeleton className="h-80 w-full" />
        )}
      </div>
      {preview.data && (
        <p className="text-muted-foreground text-xs">
          Rendered subject:{' '}
          <span className="font-medium text-foreground">{preview.data.subject}</span>
        </p>
      )}
    </div>
  )
}
