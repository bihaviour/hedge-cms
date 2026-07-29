import { HEDGE_REPO, HEDGE_VERSION } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpCircle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { UpdateDialog } from '@/components/update-dialog'
import { useSession } from '@/hooks/use-session'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/i18n'

const UPSTREAM_URL = `https://github.com/${HEDGE_REPO}`

/**
 * The running version, and — for instance admins — whether a newer Hedge release exists upstream and
 * how to move to it. An owner can update from here directly (`POST /api/v1/system/update`); everyone
 * else, and anyone who prefers it, gets a manual path that is correct for a cloned repository — the
 * deploy button creates a *clone*, not a fork, so there is no "Sync fork" button to point at.
 */
export function AboutPage() {
  const session = useSession()
  const { formatDateTime } = useFormatters()
  const permissions = session.data?.permissions ?? []
  const isAdmin = permissions.includes('system:read')
  const canUpdate = permissions.includes('system:update')

  const [updateOpen, setUpdateOpen] = useState(false)

  const version = useQuery({
    queryKey: ['system-version'],
    queryFn: api.system.version,
    enabled: isAdmin,
    staleTime: 1000 * 60 * 60,
  })

  const data = version.data
  const repoUrl = data?.repoUrl ?? null

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
                <p className="text-muted-foreground text-sm">
                  Couldn't reach GitHub to check for a newer release. This doesn't affect the
                  running deployment — try again later.
                </p>
              )}

              {data && !data.updateAvailable && (
                <p className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  {data.latest
                    ? "You're on the latest release."
                    : 'No published releases upstream yet.'}
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

                  {/* The manual path, always available and correct for a clone. A Cloudflare-created
                      repository has no upstream, so it is added explicitly before merging. */}
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

                  <div className="flex flex-wrap gap-2">
                    {repoUrl && (
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
