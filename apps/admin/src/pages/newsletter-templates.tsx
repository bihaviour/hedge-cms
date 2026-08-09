import type { NewsletterPreviewInput, NewsletterTemplate } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
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
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'

export function NewsletterTemplatesPage() {
  const [editing, setEditing] = useState<NewsletterTemplate | 'new' | null>(null)
  const siteSlug = useActiveSiteSlug()

  const templates = useQuery({
    queryKey: ['newsletter-templates', siteSlug],
    queryFn: api.newsletterTemplates.list,
    enabled: Boolean(siteSlug),
  })

  return (
    <>
      <PageHeader
        title="Newsletter templates"
        description="Reusable subject-and-body blueprints. Start a new newsletter from one instead of a blank page."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            New template
          </Button>
        }
      />

      <div className="p-8">
        {templates.isLoading && <Skeleton className="h-48 w-full" />}

        {templates.data && templates.data.length === 0 && (
          <EmptyState
            title="No templates yet"
            description="Save a layout you reuse — a monthly digest, a product update — and start from it each time."
            action={<Button onClick={() => setEditing('new')}>New template</Button>}
          />
        )}

        {templates.data && templates.data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {templates.data.map((template) => (
              <button
                type="button"
                key={template.id}
                onClick={() => setEditing(template)}
                className="flex flex-col items-start gap-2 rounded-lg border p-5 text-left transition-colors hover:bg-accent"
              >
                <div className="flex items-center gap-2 font-medium">
                  <FileText className="size-4 text-muted-foreground" />
                  {template.name}
                </div>
                <p className="truncate text-muted-foreground text-sm">
                  Subject: {template.subject}
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
  name: string
  subject: string
  body: string
}

const EMPTY: Draft = { name: '', subject: '', body: '' }

function TemplateEditor({
  template,
  onClose,
}: {
  template: NewsletterTemplate | 'new' | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(EMPTY)

  const isNew = template === 'new'
  const existing = template && template !== 'new' ? template : null

  useEffect(() => {
    if (isNew) setDraft(EMPTY)
    else if (existing) {
      setDraft({ name: existing.name, subject: existing.subject, body: existing.body })
    }
  }, [isNew, existing])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['newsletter-templates'] })

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.newsletterTemplates.create(draft)
        : api.newsletterTemplates.update((existing as NewsletterTemplate).id, draft),
    onSuccess: () => {
      invalidate()
      toast.success(isNew ? 'Template created' : 'Template saved')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: () => api.newsletterTemplates.remove((existing as NewsletterTemplate).id),
    onSuccess: () => {
      invalidate()
      toast.success('Template deleted')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Sheet open={template !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{isNew ? 'New template' : existing?.name}</SheetTitle>
          <SheetDescription>HTML is allowed in the body.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 px-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="nt-name">Template name</Label>
            <Input
              id="nt-name"
              placeholder="Monthly digest"
              value={draft.name}
              onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nt-subject">Subject</Label>
            <Input
              id="nt-subject"
              value={draft.subject}
              onChange={(event) => setDraft((d) => ({ ...d, subject: event.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nt-body">Body</Label>
            <Textarea
              id="nt-body"
              rows={8}
              value={draft.body}
              onChange={(event) => setDraft((d) => ({ ...d, body: event.target.value }))}
            />
          </div>

          <NewsletterPreview subject={draft.subject} body={draft.body} />
        </div>

        <SheetFooter className="flex-row justify-between gap-2">
          {existing ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            disabled={save.isPending || !draft.name || !draft.subject || !draft.body}
            onClick={() => save.mutate()}
          >
            {isNew ? 'Create template' : 'Save template'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** Live preview of a subject and body, refreshed shortly after the operator stops typing. */
export function NewsletterPreview({
  subject,
  body,
  senderId,
}: {
  subject: string
  body: string
  /** The draft's chosen sender, so the preview's brand matches what will send (#136). */
  senderId?: string | null
}) {
  const [debounced, setDebounced] = useState<NewsletterPreviewInput>({ subject, body, senderId })

  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ subject, body, senderId }), 400)
    return () => clearTimeout(timer)
  }, [subject, body, senderId])

  const preview = useQuery({
    queryKey: ['newsletter-preview', debounced],
    queryFn: () => api.newsletterTemplates.preview(debounced),
    enabled: Boolean(debounced.subject && debounced.body),
  })

  return (
    <div className="space-y-2">
      <Label>Preview</Label>
      <div className="overflow-hidden rounded-lg border bg-muted/30">
        {preview.data ? (
          <iframe
            title="Newsletter preview"
            className="h-80 w-full bg-white"
            sandbox=""
            srcDoc={preview.data.html}
          />
        ) : (
          <Skeleton className="h-80 w-full" />
        )}
      </div>
    </div>
  )
}
