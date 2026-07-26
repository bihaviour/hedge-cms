import { API_KEY_SCOPE_LABELS, API_KEY_SCOPES, type ApiKeyScope } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
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

      <div className="p-8">
        {keys.isLoading && <Skeleton className="h-48 w-full" />}

        {keys.data?.length === 0 && (
          <EmptyState
            title={t('apiKeys.emptyTitle')}
            description={t('apiKeys.emptyDescription')}
            action={<Button onClick={() => setOpen(true)}>{t('apiKeys.new')}</Button>}
          />
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
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('apiKeys.revokeAria', { name: key.name })}
                        onClick={() => remove.mutate(key.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <CreateKeyDialog open={open} onOpenChange={setOpen} onIssued={setIssued} />

      <Dialog open={issued !== null} onOpenChange={() => setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key</DialogTitle>
            <DialogDescription>
              This is the only time it will be shown. Store it somewhere safe.
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
              onClick={() => {
                if (issued) navigator.clipboard.writeText(issued)
                toast.success('Copied to clipboard')
              }}
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
