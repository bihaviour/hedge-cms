import type { MetaEntry, SiteEmailSender, SiteMetadata } from '@hedge/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type FieldRow, FieldsEditor, toFieldRows } from '@/components/fields-editor'
import { PageHeader } from '@/components/page-header'
import { SocialImageInput } from '@/components/social-image-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useActiveSite } from '@/hooks/use-site'
import { ApiClientError, api } from '@/lib/api'

const EMPTY_META: SiteMetadata = { keywords: [], custom: [] }

/** An input holds a string; an empty one is a cleared override, which the API takes as null. */
type SenderForm = Record<keyof SiteEmailSender, string>

const EMPTY_SENDER: SenderForm = { fromEmail: '', fromName: '', replyTo: '' }

function toSenderForm(sender: SiteEmailSender): SenderForm {
  return {
    fromEmail: sender.fromEmail ?? '',
    fromName: sender.fromName ?? '',
    replyTo: sender.replyTo ?? '',
  }
}

/** A blank field is an override the site is giving up, sent as null so the fallback applies again. */
function toSenderInput(sender: SenderForm): SiteEmailSender {
  return {
    fromEmail: sender.fromEmail.trim() || null,
    fromName: sender.fromName.trim() || null,
    replyTo: sender.replyTo.trim() || null,
  }
}

/**
 * Per-site metadata defaults, custom fields and email sender — everything here is unique to the
 * active site. The metadata block is the SEO/social defaults every entry inherits; the custom
 * fields are extra, site-wide fields that appear on every entry's metadata panel.
 */
export function SiteSettingsPage() {
  const queryClient = useQueryClient()
  const { site, isLoading } = useActiveSite()

  const [meta, setMeta] = useState<SiteMetadata>(EMPTY_META)
  const [rows, setRows] = useState<FieldRow[]>([])
  const [sender, setSender] = useState<SenderForm>(EMPTY_SENDER)
  const [newsletterSender, setNewsletterSender] = useState<SenderForm>(EMPTY_SENDER)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewEmbed, setPreviewEmbed] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})

  // Reseed whenever the active site changes — the form is per-site.
  useEffect(() => {
    if (site) {
      setMeta({ ...EMPTY_META, ...site.metadata })
      setRows(toFieldRows(site.customFields))
      setSender(toSenderForm(site.emailSender))
      setNewsletterSender(toSenderForm(site.newsletterSender))
      setPreviewUrl(site.previewUrl ?? '')
      setPreviewEmbed(site.previewEmbed)
    }
  }, [site])

  const save = useMutation({
    mutationFn: () =>
      api.sites.updateConfig(site!.slug, {
        metadata: meta,
        customFields: rows.map((row) => row.field),
        // A blank field is an override the site is giving up, sent as null so the deployment
        // sender applies to it again.
        emailSender: toSenderInput(sender),
        newsletterSender: toSenderInput(newsletterSender),
        // Blank means "this site has no preview endpoint", which hides the action rather than
        // rendering a button that would send an editor to a URL nobody serves.
        previewUrl: previewUrl.trim() || null,
        previewEmbed,
      }),
    onSuccess: () => {
      setFieldErrors({})
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success('Site settings saved')
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.details) setFieldErrors(error.details)
      toast.error(error.message)
    },
  })

  if (isLoading || !site) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  function patchMeta(patch: Partial<SiteMetadata>) {
    setMeta((current) => ({ ...current, ...patch }))
  }

  return (
    <>
      <PageHeader
        title="Site settings"
        description={`Metadata defaults, custom fields and email sender for "${site.name}".`}
        actions={
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save changes
          </Button>
        }
      />

      <div className="max-w-3xl space-y-10 p-8">
        <section className="space-y-5">
          <div>
            <h2 className="font-medium text-lg">Metadata defaults</h2>
            <p className="text-muted-foreground text-sm">
              Inherited by every entry on this site unless the entry overrides them.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="meta-title">Default title</Label>
              <Input
                id="meta-title"
                value={meta.metaTitle ?? ''}
                onChange={(event) => patchMeta({ metaTitle: event.target.value || undefined })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="meta-template">Title template</Label>
              <Input
                id="meta-template"
                placeholder="%s · My Site"
                value={meta.titleTemplate ?? ''}
                onChange={(event) => patchMeta({ titleTemplate: event.target.value || undefined })}
              />
              <p className="text-muted-foreground text-xs">
                <code>%s</code> is replaced with the entry's title.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-description">Default description</Label>
            <Textarea
              id="meta-description"
              rows={2}
              value={meta.description ?? ''}
              onChange={(event) => patchMeta({ description: event.target.value || undefined })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <SocialImageInput
              id="meta-og"
              value={meta.ogImage}
              onChange={(ogImage) => patchMeta({ ogImage })}
            />
            <div className="space-y-2">
              <Label htmlFor="meta-twitter">Twitter handle</Label>
              <Input
                id="meta-twitter"
                placeholder="@handle"
                value={meta.twitterHandle ?? ''}
                onChange={(event) => patchMeta({ twitterHandle: event.target.value || undefined })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-keywords">Keywords</Label>
            <Input
              id="meta-keywords"
              placeholder="comma, separated, keywords"
              value={meta.keywords.join(', ')}
              onChange={(event) =>
                patchMeta({
                  keywords: event.target.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>

          <CustomPairs pairs={meta.custom} onChange={(custom) => patchMeta({ custom })} />
        </section>

        <section className="space-y-5">
          <div>
            <h2 className="font-medium text-lg">Custom fields</h2>
            <p className="text-muted-foreground text-sm">
              Extra fields shown on every entry's metadata panel, on top of its collection's own
              fields.
            </p>
          </div>

          <FieldsEditor rows={rows} onChange={setRows} addLabel="Add custom field" />

          {Object.entries(fieldErrors).length > 0 && (
            <ul className="space-y-1 text-destructive text-xs">
              {Object.entries(fieldErrors).map(([key, messages]) => (
                <li key={key}>
                  <span className="font-mono">{key}</span>: {messages.join(', ')}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-5">
          <div>
            <h2 className="font-medium text-lg">Preview</h2>
            <p className="text-muted-foreground text-sm">
              Where the Preview action in the entry editor sends an editor, so they can see an
              unpublished entry in this website's own layout. Leave it blank and the action is
              hidden. Each collection can set its own path underneath this URL.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="preview-url">Preview URL</Label>
            <Input
              id="preview-url"
              type="url"
              placeholder="https://example.com/preview"
              value={previewUrl}
              onChange={(event) => setPreviewUrl(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              The full origin including the scheme — <code>https://example.com</code>, not{' '}
              <code>example.com</code> — and no trailing slash. Your website reads the token from
              the query string and forwards it to the delivery API from its own server.
            </p>
            {fieldErrors.previewUrl && (
              <p className="text-destructive text-xs">{fieldErrors.previewUrl.join(', ')}</p>
            )}
          </div>

          <div className="flex items-start gap-2">
            <Switch id="preview-embed" checked={previewEmbed} onCheckedChange={setPreviewEmbed} />
            <div className="space-y-1">
              <Label htmlFor="preview-embed" className="font-normal text-sm">
                Show previews in a pane inside the admin
              </Label>
              <p className="text-muted-foreground text-xs">
                Off by default: the pane renders blank unless your website allows this CMS to frame
                it, which needs a <code>frame-ancestors</code> entry in its
                <code> Content-Security-Policy</code>. With this off, Preview opens in a new tab,
                which always works.
              </p>
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            A preview link carries a signed token that unlocks one entry for about half an hour. It
            lands in browser history and can reach the target site as a referrer, which is what the
            short life is for — treat one like a password for that single article.
          </p>
        </section>

        <section className="space-y-5">
          <div>
            <h2 className="font-medium text-lg">Member email sender</h2>
            <p className="text-muted-foreground text-sm">
              What the invite, reset, verification and sign-in emails this site's members receive
              are sent as. Leave a field blank to inherit the deployment sender from Configuration →
              Email. Operator invites and password resets always use the deployment sender.
            </p>
          </div>
          <SenderFields idPrefix="member" values={sender} onChange={setSender} />
        </section>

        <section className="space-y-5">
          <div>
            <h2 className="font-medium text-lg">Newsletter sender</h2>
            <p className="text-muted-foreground text-sm">
              The default sender for this site's newsletters, separate from member email. A single
              newsletter can override it on the compose screen — so an author can send as themselves
              — and a blank field here inherits the deployment sender.
            </p>
          </div>
          <SenderFields
            idPrefix="newsletter"
            values={newsletterSender}
            onChange={setNewsletterSender}
          />
        </section>
      </div>
    </>
  )
}

/**
 * One sender identity's three inputs. A site carries two — member and newsletter — so this is
 * shared rather than duplicated, and `idPrefix` keeps their label/input ids distinct on the page.
 */
function SenderFields({
  idPrefix,
  values,
  onChange,
}: {
  idPrefix: string
  values: SenderForm
  onChange: (update: (s: SenderForm) => SenderForm) => void
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-from-email`}>From address</Label>
          <Input
            id={`${idPrefix}-from-email`}
            type="email"
            placeholder="Deployment default"
            value={values.fromEmail}
            onChange={(event) => onChange((s) => ({ ...s, fromEmail: event.target.value }))}
          />
          <p className="text-muted-foreground text-xs">
            Must be on a domain onboarded with Cloudflare Email Sending, or the send fails.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-from-name`}>From name</Label>
          <Input
            id={`${idPrefix}-from-name`}
            placeholder="Deployment default"
            value={values.fromName}
            onChange={(event) => onChange((s) => ({ ...s, fromName: event.target.value }))}
          />
        </div>
      </div>

      <div className="space-y-2 sm:max-w-[calc(50%-0.5rem)]">
        <Label htmlFor={`${idPrefix}-reply-to`}>Reply-to address</Label>
        <Input
          id={`${idPrefix}-reply-to`}
          type="email"
          placeholder="Deployment default"
          value={values.replyTo}
          onChange={(event) => onChange((s) => ({ ...s, replyTo: event.target.value }))}
        />
      </div>
    </>
  )
}

/** The free-form key/value metadata pairs — an escape hatch for whatever has no dedicated field. */
function CustomPairs({
  pairs,
  onChange,
}: {
  pairs: MetaEntry[]
  onChange: (pairs: MetaEntry[]) => void
}) {
  return (
    <div className="space-y-2">
      <Label>Custom metadata</Label>
      <div className="space-y-2">
        {pairs.map((pair, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: pairs have no stable id and reorder only on delete
          <div key={index} className="flex gap-2">
            <Input
              className="font-mono"
              placeholder="key"
              value={pair.key}
              onChange={(event) =>
                onChange(pairs.map((p, i) => (i === index ? { ...p, key: event.target.value } : p)))
              }
            />
            <Input
              placeholder="value"
              value={pair.value}
              onChange={(event) =>
                onChange(
                  pairs.map((p, i) => (i === index ? { ...p, value: event.target.value } : p)),
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove metadata pair"
              onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
      >
        <Plus className="size-4" />
        Add pair
      </Button>
    </div>
  )
}
