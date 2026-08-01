import { HEDGE_REPO, HEDGE_VERSION } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpCircle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { UpdateDialog } from '@/components/update-dialog'
import { useSession } from '@/hooks/use-session'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const UPSTREAM_URL = `https://github.com/${HEDGE_REPO}`

/**
 * The running version, and — for instance admins — whether a newer Hedge release exists upstream and
 * how to move to it.
 *
 * **Which instructions appear depends on how the deployment was installed** (#39). There are three
 * ways in after Stage 2 of #31, and they do not share an update path:
 *
 * - all three — the dashboard update, for an owner (`POST /api/v1/system/update`)
 * - `button` / `cli` — plus the git fallback, which is correct for a *clone*: the deploy button
 *   clones rather than forks, so there is no "Sync fork" button to point at and the upstream has to
 *   be added explicitly before merging
 * - `installer` — no git fallback at all, because there is no repository. Offering one would tell
 *   the operator to go somewhere that does not exist, which is worse than offering nothing
 *
 * `null` — every deployment installed before the var existed — gets both, claiming no relationship
 * to a repository. That is the pre-#39 behaviour, and it is the safe reading of "we don't know".
 */
export function AboutPage() {
  const session = useSession()
  const { formatDateTime } = useFormatters()
  const permissions = session.data?.permissions ?? []
  const isAdmin = permissions.includes('system:read')
  const canUpdate = permissions.includes('system:update')

  const [updateOpen, setUpdateOpen] = useState(false)
  const queryClient = useQueryClient()

  const version = useQuery({
    queryKey: ['system-version'],
    // Wrapped rather than passed by reference: TanStack calls `queryFn` with a context object, which
    // would arrive as `refresh` and make every ordinary load a forced GitHub check.
    queryFn: () => api.system.version(),
    enabled: isAdmin,
    staleTime: 1000 * 60 * 60,
  })

  /**
   * "Check again" — the server answer is edge-cached for six hours, so a plain refetch would hand
   * back the same stale result. This asks the server to skip that cache, which is what an operator
   * who has just published a release needs and is rate limited on the other side.
   */
  const recheck = useMutation({
    mutationFn: () => api.system.version(true),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['system-version'], fresh)
      toast.success(
        fresh.updateAvailable
          ? `Hedge ${fresh.latest} is available.`
          : "You're on the latest release.",
      )
    },
    onError: (error) => toast.error(error.message),
  })

  const data = version.data
  const repoUrl = data?.repoUrl ?? null
  // An installer deployment has no repository, so it is the one case with no git path to show.
  // Unknown (`null`) keeps the git path: it is true for the button and the CLI, which are the only
  // two ways a deployment predating this var can have been made.
  const hasRepository = data ? data.installedBy !== 'installer' : true

  return (
    <>
      <PageHeader
        title="About & updates"
        description="The version of Hedge this deployment runs."
      />

      <div className="flex max-w-2xl flex-col gap-6 p-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Hedge
              <Badge variant="secondary" className="font-mono">
                {HEDGE_VERSION}
              </Badge>
            </CardTitle>
            <CardDescription>
              A headless, edge-native CMS running on Cloudflare Workers.
            </CardDescription>
          </CardHeader>

          {isAdmin && (
            <CardContent className="space-y-4">
              {version.isLoading && (
                <p className="flex items-center gap-2 text-muted-foreground text-sm">
                  <RefreshCw className="size-4 animate-spin" /> Checking for updates…
                </p>
              )}

              {version.isError && (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-sm">
                    Couldn't reach GitHub to check for a newer release. This doesn't affect the
                    running deployment.
                  </p>
                  {/* A failed check is cached too, so "try again later" used to mean six hours. */}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={recheck.isPending}
                    onClick={() => recheck.mutate()}
                  >
                    <RefreshCw className={cn('size-4', recheck.isPending && 'animate-spin')} />
                    Try again
                  </Button>
                </div>
              )}

              {data && !data.updateAvailable && (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  {data.latest
                    ? "You're on the latest release."
                    : 'No published releases upstream yet.'}
                  {/* The answer above is cached for six hours, so somebody who has just published a
                      release would otherwise be told they are current and have no way to disagree. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={recheck.isPending}
                    onClick={() => recheck.mutate()}
                  >
                    <RefreshCw className={cn('size-4', recheck.isPending && 'animate-spin')} />
                    {recheck.isPending ? 'Checking…' : 'Check again'}
                  </Button>
                </p>
              )}

              {data?.updateAvailable && (
                <div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <p className="flex items-center gap-2 font-medium text-sm">
                    <ArrowUpCircle className="size-4 text-primary" />
                    Hedge {data.latest} is available.
                    {data.publishedAt && (
                      <span className="font-normal text-muted-foreground">
                        released {formatDateTime(data.publishedAt)}
                      </span>
                    )}
                  </p>

                  {/* The dashboard update: owner-only, gated with the same permission the server
                      enforces (UI gating is cosmetic — the server check in #35 is the real one). */}
                  {canUpdate && data.latest && (
                    <div className="space-y-2">
                      <Button size="sm" onClick={() => setUpdateOpen(true)}>
                        <ArrowUpCircle className="size-4" /> Update now
                      </Button>
                      <p className="text-muted-foreground text-xs">
                        Deploys the new release from here using a Cloudflare API token you paste
                        once. The token is never stored.
                      </p>
                    </div>
                  )}

                  {/* The git fallback — for a deployment that has a repository. Correct for a
                      clone: a Cloudflare-created repository has no upstream, so it is added
                      explicitly before merging. */}
                  {hasRepository && (
                    <div className="space-y-2">
                      <p className="text-muted-foreground text-sm">
                        {canUpdate
                          ? 'Or update manually:'
                          : 'To update, from a checkout of your repository:'}
                      </p>
                      <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
                        <code>
                          {`git remote add upstream ${UPSTREAM_URL}\n`}
                          {'git fetch upstream && git merge upstream/main && git push'}
                        </code>
                      </pre>
                      <p className="text-muted-foreground text-xs">
                        Cloudflare Workers Builds redeploys on the push and runs pending database
                        migrations automatically. Skip the first line if you have already added the
                        upstream remote.
                      </p>
                    </div>
                  )}

                  {/* Installed without a repository. There is nothing to sync, nothing to push and
                      no Workers Build to trigger, so the dashboard update is the whole story — and
                      the operator needs telling that rather than being left to wonder. */}
                  {!hasRepository && (
                    <p className="text-muted-foreground text-sm">
                      {canUpdate
                        ? 'This deployment was created by the Hedge installer, so it has no Git repository to sync — updating from here is the way it updates.'
                        : 'This deployment was created by the Hedge installer, so it has no Git repository to sync. An owner can update it from this page.'}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {repoUrl && hasRepository && (
                      <Button asChild size="sm" variant="outline">
                        <a href={repoUrl} target="_blank" rel="noreferrer">
                          Open your repository <ExternalLink className="size-3.5" />
                        </a>
                      </Button>
                    )}
                    {data.notesUrl && (
                      <Button asChild size="sm" variant="outline">
                        <a href={data.notesUrl} target="_blank" rel="noreferrer">
                          Release notes <ExternalLink className="size-3.5" />
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {data && (
                <p className="text-muted-foreground text-xs">
                  Last checked {formatDateTime(data.checkedAt)}.
                </p>
              )}
            </CardContent>
          )}
        </Card>
      </div>

      {data?.latest && (
        <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} targetVersion={data.latest} />
      )}
    </>
  )
}
