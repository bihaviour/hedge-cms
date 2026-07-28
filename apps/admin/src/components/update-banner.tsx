import { HEDGE_VERSION, type User } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpCircle } from 'lucide-react'
import { Link } from 'react-router'
import { api } from '@/lib/api'

/**
 * A one-line nudge, shown only to instance admins when the upstream project has cut a newer release
 * than this deployment runs. It links to the About page where the how-to-update steps live: the
 * Worker can't redeploy itself, so this points at the person who can rather than pretending to be a
 * button that updates in place.
 */
export function UpdateBanner({ user }: { user: User }) {
  const isAdmin = user.permissions.includes('system:read')
  const version = useQuery({
    queryKey: ['system-version'],
    queryFn: api.system.version,
    // Only admins can reach the route; asking as anyone else just earns a 403.
    enabled: isAdmin,
    // The server caches the GitHub check for hours; there is no value in re-asking on every mount.
    staleTime: 1000 * 60 * 60,
  })

  if (!isAdmin || !version.data?.updateAvailable) return null

  return (
    <Link
      to="/settings/about"
      className="flex items-center gap-2 border-b bg-primary/10 px-8 py-2 text-sm hover:bg-primary/15"
    >
      <ArrowUpCircle className="size-4 shrink-0 text-primary" />
      <span>
        Hedge <strong>{version.data.latest}</strong> is available — this deployment runs{' '}
        {HEDGE_VERSION}.
      </span>
      <span className="ml-auto font-medium text-primary">How to update →</span>
    </Link>
  )
}
