import { HEDGE_VERSION } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpCircle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useSession } from '@/hooks/use-session'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/i18n'

/**
 * The running version, and — for instance admins — whether a newer Hedge release exists upstream
 * and how to move to it. Updating is deliberately guided rather than automatic: a deployment is the
 * operator's own fork that Cloudflare Workers Builds redeploys on push, so the update happens on
 * GitHub (or GitLab), not from inside a Worker that holds no deploy credentials.
 */
export function AboutPage() {
  const session = useSession()
  const { formatDateTime } = useFormatters()
  const isAdmin = session.data?.permissions.includes('system:read') ?? false

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

                  {/* The deploy model is fork → Workers Builds → redeploy, so updating is a sync on
                      the operator's own repository. Migrations run in the deploy script, so there
                      is no separate database step to remember. */}
                  <ol className="ml-4 list-decimal space-y-1 text-muted-foreground text-sm">
                    <li>Open your Hedge fork on GitHub or GitLab.</li>
                    <li>
                      Use <strong>Sync fork → Update branch</strong> to pull in the new release.
                    </li>
                    <li>
                      Cloudflare Workers Builds redeploys on the push and runs pending database
                      migrations automatically.
                    </li>
                  </ol>

                  <div className="flex flex-wrap gap-2">
                    {repoUrl && (
                      <Button asChild size="sm">
                        <a href={repoUrl} target="_blank" rel="noreferrer">
                          Open your fork to sync <ExternalLink className="size-3.5" />
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
    </>
  )
}
