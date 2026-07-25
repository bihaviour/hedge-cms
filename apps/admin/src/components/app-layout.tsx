import type { User } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { Boxes, Image, KeyRound, LogOut, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useLogout } from '@/hooks/use-session'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/collections', label: 'Collections', icon: Boxes },
  { to: '/media', label: 'Media', icon: Image },
  { to: '/settings/users', label: 'Users', icon: Users },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyRound },
]

export function AppLayout({ user }: { user: User }) {
  const logout = useLogout()
  const collections = useQuery({ queryKey: ['collections'], queryFn: api.collections.list })

  return (
    <div className="flex min-h-svh">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-card/40">
        <div className="px-5 py-5">
          <p className="font-semibold tracking-tight">Hedge</p>
          <p className="text-muted-foreground text-xs">headless + edge CMS</p>
        </div>
        <Separator />

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}

          {collections.data && collections.data.length > 0 && (
            <div className="pt-4">
              <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Content
              </p>
              {collections.data.map((collection) => (
                <NavLink
                  key={collection.id}
                  to={`/collections/${collection.slug}`}
                  className={({ isActive }) =>
                    cn(
                      'block truncate rounded-md px-3 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )
                  }
                >
                  {collection.name}
                </NavLink>
              ))}
            </div>
          )}
        </nav>

        <Separator />
        <div className="flex items-center justify-between gap-2 p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-muted-foreground text-xs capitalize">{user.role}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}
