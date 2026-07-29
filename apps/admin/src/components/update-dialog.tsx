import {
  REQUIRED_TOKEN_PERMISSIONS,
  type SystemUpdateResult,
  type UpdateStepStatus,
} from '@hedge/core'
import { useMutation } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
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
import { ApiClientError, api } from '@/lib/api'

/** Where the operator creates the token, and the exact permissions it needs. */
const TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens'

/**
 * Drives `POST /api/v1/system/update` from the dashboard.
 *
 * The Cloudflare token is held in component state and nowhere else — no autofill, no `localStorage`,
 * cleared when the dialog closes. The three steps (upload → migrate → deploy) each get an outcome,
 * so "migrations applied, not yet deployed" is shown as the first-class state it is rather than a
 * toast. On a clean success the page is reloaded, because the SPA in the browser is the old build.
 */
export function UpdateDialog({
  open,
  onOpenChange,
  targetVersion,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetVersion: string
}) {
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.system.update({ token, accountId, targetVersion }),
  })

  const running = mutation.isPending

  // Never let the token outlive the dialog: clear it (and any prior result) as the dialog closes.
  // An in-flight update is not abandonable, so a close is ignored while running.
  const handleOpenChange = (next: boolean) => {
    if (running) return
    if (!next) {
      setToken('')
      setAccountId('')
      mutation.reset()
    }
    onOpenChange(next)
  }

  const result = mutation.data
  const succeeded = result?.ok === true

  // The browser is still running the old build; a reload is what surfaces the new version.
  useEffect(() => {
    if (!succeeded) return
    const timer = setTimeout(() => window.location.reload(), 2000)
    return () => clearTimeout(timer)
  }, [succeeded])

  const preflightError = mutation.error instanceof ApiClientError ? mutation.error.message : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update to Hedge {targetVersion}</DialogTitle>
          <DialogDescription>
            Hedge deploys itself using a Cloudflare API token you paste here. The token is used once
            and never stored — not in your browser, not on the server.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <UpdateOutcome result={result} onReload={() => window.location.reload()} />
        ) : (
          <div className="space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
              <li>The new version is uploaded to Cloudflare, without going live yet.</li>
              <li>Pending database migrations are applied.</li>
              <li>The new version is deployed — this is the moment it starts serving.</li>
            </ol>

            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Create a token with these permissions:</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {REQUIRED_TOKEN_PERMISSIONS.map((permission) => (
                  <li key={permission}>
                    Account · <span className="font-mono text-xs">{permission}</span>
                  </li>
                ))}
              </ul>
              <a
                href={TOKEN_PAGE}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 font-medium text-primary text-sm hover:underline"
              >
                Open the Cloudflare API tokens page <ExternalLink className="size-3.5" />
              </a>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-account-id">Cloudflare account ID</Label>
              <Input
                id="cf-account-id"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                placeholder="e.g. 0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
              <p className="text-muted-foreground text-xs">
                On the Cloudflare dashboard, under Workers &amp; Pages → your Worker → overview.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-token">Cloudflare API token</Label>
              <Input
                id="cf-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Pasted once, never stored"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                className="font-mono text-sm"
              />
            </div>

            {preflightError && (
              <p className="flex items-start gap-2 text-destructive text-sm">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                {preflightError}
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={running}>
                Cancel
              </Button>
              <Button
                onClick={() => mutation.mutate()}
                disabled={running || !token.trim() || !accountId.trim()}
              >
                {running && <Loader2 className="size-4 animate-spin" />}
                {running ? 'Updating…' : 'Update now'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function UpdateOutcome({ result, onReload }: { result: SystemUpdateResult; onReload: () => void }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border p-3">
        <StepRow label="New version uploaded" status={result.steps.version.status} />
        <StepRow
          label="Database migrations applied"
          status={result.steps.migrations.status}
          detail={
            result.steps.migrations.applied.length
              ? `${result.steps.migrations.applied.filter((m) => m.status === 'applied').length} applied`
              : undefined
          }
        />
        <StepRow label="New version deployed" status={result.steps.deployment.status} />
      </div>

      {result.ok ? (
        <div className="space-y-3 rounded-md border border-emerald-600/30 bg-emerald-600/5 p-3">
          <p className="flex items-center gap-2 font-medium text-sm">
            <CheckCircle2 className="size-4 text-emerald-600" />
            Updated to Hedge {result.toVersion}. Reloading…
          </p>
          <Button size="sm" onClick={onReload}>
            <RefreshCw className="size-4" /> Reload now
          </Button>
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-amber-600/40 bg-amber-600/5 p-3">
          <p className="flex items-center gap-2 font-medium text-sm">
            <AlertTriangle className="size-4 text-amber-600" />
            The update did not finish
          </p>
          <p className="text-muted-foreground text-sm">{result.message}</p>
        </div>
      )}
    </div>
  )
}

function StepRow({
  label,
  status,
  detail,
}: {
  label: string
  status: UpdateStepStatus
  detail?: string
}) {
  const icon =
    status === 'done' ? (
      <CheckCircle2 className="size-4 text-emerald-600" />
    ) : status === 'skipped' ? (
      <CircleDashed className="size-4 text-muted-foreground" />
    ) : (
      <XCircle className="size-4 text-destructive" />
    )

  return (
    <div className="flex items-center gap-2 text-sm">
      {icon}
      <span className={status === 'failed' ? 'text-destructive' : undefined}>{label}</span>
      {detail && <span className="text-muted-foreground text-xs">· {detail}</span>}
      {status === 'skipped' && (
        <span className="text-muted-foreground text-xs">· nothing to do</span>
      )}
    </div>
  )
}
