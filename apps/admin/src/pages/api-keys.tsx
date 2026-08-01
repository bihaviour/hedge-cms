import { API_KEY_SCOPE_LABELS, API_KEY_SCOPES, type ApiKey, type ApiKeyScope } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'

export function ApiKeysPage() {
  const t = useT()
  const { formatDate } = useFormatters()
  const [open, setOpen] = useState(false)
  const [issued, setIssued] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<ApiKey | null>(null)
  const [rotating, setRotating] = useState<ApiKey | null>(null)
  const queryClient = useQueryClient()

  const siteSlug = useActiveSiteSlug()
  const keys = useQuery({
    queryKey: ['api-keys', siteSlug],
    queryFn: api.apiKeys.list,
    enabled: Boolean(siteSlug),
  })

  const remove = useMutation({
    mutationFn: api.apiKeys.remove,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      toast.success(t('apiKeys.revoked'))
    },
  })

  // Sites created before keys were issued automatically — and any whose delivery key was revoked —
  // have no `content:read` key, so no website can read them. Surface a one-click prompt to issue it
  // with the right scope rather than leaving the operator to infer which of the scopes is safe.
  const hasDeliveryKey = keys.data?.some((key) => key.scopes.includes('content:read'))
  const issueDelivery = useMutation({
    mutationFn: () => api.apiKeys.create({ name: 'delivery', scopes: ['content:read'] }),
    onSuccess: (key) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      setIssued(key.key)
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title={t('apiKeys.title')}
        description={t('apiKeys.subtitle')}
        actions={
          <Button onClick={() => setOpen(true)}>
            <KeyRound className="size-4" />
            {t('apiKeys.new')}
          </Button>
        }
      />

      <div className="space-y-6 p-8">
        {keys.isLoading && <Skeleton className="h-48 w-full" />}

        {keys.data && !hasDeliveryKey && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-dashed p-6">
            <div>
              <h3 className="font-medium">No delivery key</h3>
              <p className="text-muted-foreground text-sm">
                A website reads this site's published content with a{' '}
                <code className="font-mono text-xs">content:read</code> key. Issue one now, or
                create a custom key.
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => issueDelivery.mutate()} disabled={issueDelivery.isPending}>
                Issue delivery key
              </Button>
              <Button variant="outline" onClick={() => setOpen(true)}>
                {t('apiKeys.new')}
              </Button>
            </div>
          </div>
        )}

        {keys.data && keys.data.length > 0 && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('apiKeys.colName')}</TableHead>
                  <TableHead className="w-40">{t('apiKeys.colPrefix')}</TableHead>
                  <TableHead>{t('apiKeys.colScopes')}</TableHead>
                  <TableHead className="w-32">{t('apiKeys.colLastUsed')}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs">
                      {key.prefix}…
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge key={scope} variant="secondary" className="font-mono text-xs">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(key.lastUsedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('apiKeys.renameAria', { name: key.name })}
                          title={t('apiKeys.rename')}
                          onClick={() => setRenaming(key)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('apiKeys.rotateAria', { name: key.name })}
                          title={t('apiKeys.rotate')}
                          onClick={() => setRotating(key)}
                        >
                          <RefreshCw className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('apiKeys.revokeAria', { name: key.name })}
                          title={t('apiKeys.revoke')}
                          onClick={() => remove.mutate(key.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <CreateKeyDialog open={open} onOpenChange={setOpen} onIssued={setIssued} />
      <RenameKeyDialog apiKey={renaming} onOpenChange={() => setRenaming(null)} />
      <RotateKeyDialog
        apiKey={rotating}
        onOpenChange={() => setRotating(null)}
        onIssued={setIssued}
      />

      <Dialog open={issued !== null} onOpenChange={() => setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key</DialogTitle>
            <DialogDescription>
              This is the only time it will be shown — only a hash of it is stored, so it cannot be
              displayed again. If you lose it, rotate the key to issue a replacement.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">
              {issued}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy key"
              onClick={() => copyKey(issued)}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Copies a secret and reports honestly whether it worked. `navigator.clipboard` needs a secure
 * context, so on a plain-HTTP deployment it rejects — and a success toast over a clipboard that
 * never received the key is how somebody closes the one dialog that will ever show it.
 */
async function copyKey(key: string | null) {
  if (!key) return
  try {
    await navigator.clipboard.writeText(key)
    toast.success('Copied to clipboard')
  } catch {
    toast.error('Could not copy — select the key and copy it manually.')
  }
}

/** Renaming is the one edit a key allows; scopes and the secret are fixed at issue. */
function RenameKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')

  // The dialog is mounted once and fed a different key each time it opens, so the field is seeded
  // from whichever key that is rather than from an initial value that would only ever be the first.
  useEffect(() => {
    if (apiKey) setName(apiKey.name)
  }, [apiKey])

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api.apiKeys.update(input.id, { name: input.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      toast.success('Key renamed')
      onOpenChange(false)
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={apiKey !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (apiKey) rename.mutate({ id: apiKey.id, name })
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename key</DialogTitle>
            <DialogDescription>
              The name is only a label. The secret, its scopes and the site it belongs to do not
              change.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            <Label htmlFor="rename-key">Name</Label>
            <Input
              id="rename-key"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending || !name}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Rotating issues a new secret for a key whose old one was lost.
 *
 * Confirmed rather than done on click, because it is as disruptive as a delete for whatever still
 * holds the old secret — a website using it starts returning errors the moment this completes.
 */
function RotateKeyDialog({
  apiKey,
  onOpenChange,
  onIssued,
}: {
  apiKey: ApiKey | null
  onOpenChange: (open: boolean) => void
  onIssued: (key: string) => void
}) {
  const queryClient = useQueryClient()

  const rotate = useMutation({
    mutationFn: (id: string) => api.apiKeys.rotate(id),
    onSuccess: (key) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      onOpenChange(false)
      onIssued(key.key)
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={apiKey !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate “{apiKey?.name}”?</DialogTitle>
          <DialogDescription>
            A new secret is issued and shown once. The current one stops working immediately, so
            anything still using it — a website, a script — fails until you paste the new one in.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={rotate.isPending}
            onClick={() => apiKey && rotate.mutate(apiKey.id)}
          >
            Rotate key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onIssued: (key: string) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['content:read'])

  const create = useMutation({
    mutationFn: api.apiKeys.create,
    onSuccess: (key) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      onOpenChange(false)
      onIssued(key.key)
      setName('')
      setScopes(['content:read'])
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate({ name, scopes })
          }}
        >
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              Grant only the scopes the consumer needs. The key is issued for the site you are
              currently in and cannot read any other.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                required
                placeholder="Marketing site"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-3">
              <Label>Scopes</Label>
              {API_KEY_SCOPES.map((scope) => (
                <div key={scope} className="flex items-start justify-between gap-3 text-sm">
                  <Label htmlFor={`scope-${scope}`} className="font-normal">
                    <span className="font-mono text-xs">{scope}</span>
                    <span className="block text-muted-foreground text-xs">
                      {API_KEY_SCOPE_LABELS[scope]}
                    </span>
                  </Label>
                  <Switch
                    id={`scope-${scope}`}
                    checked={scopes.includes(scope)}
                    onCheckedChange={(checked) =>
                      setScopes((current) =>
                        checked ? [...current, scope] : current.filter((s) => s !== scope),
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name || scopes.length === 0}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
