import { roleAtLeast, type User } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Layers, LogOut, Plus } from 'lucide-react'
import type * as React from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { useLogout } from '@/hooks/use-session'
import { useActiveSite, useActiveSiteSlug, useSwitchSite } from '@/hooks/use-site'
import { api } from '@/lib/api'

/**
 * Static nav. Collections fills its sub-items from the API; everything else is fixed.
 *
 * `instanceOnly` items are managing the deployment rather than a site, so they are hidden from
 * editors and viewers — the API would refuse them anyway, and offering a door that does not open
 * is worse than not showing it. API keys stays: it is gated by the *site* role, which a
 * per-site admin can hold without being an instance admin.
 */
const NAV = [
  {
    title: 'Content',
    items: [
      { title: 'Collections', url: '/collections' },
      { title: 'Media', url: '/media' },
    ],
  },
  {
    title: 'Audience',
    items: [{ title: 'Members', url: '/members' }],
  },
  {
    title: 'Settings',
    items: [
      { title: 'Sites', url: '/settings/sites', instanceOnly: true },
      { title: 'Users', url: '/settings/users', instanceOnly: true },
      { title: 'API keys', url: '/settings/api-keys' },
    ],
  },
]

export function AppSidebar({
  user,
  ...props
}: { user: User } & React.ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation()
  const logout = useLogout()
  const siteSlug = useActiveSiteSlug()
  const collections = useQuery({
    queryKey: ['collections', siteSlug],
    queryFn: api.collections.list,
    enabled: Boolean(siteSlug),
  })

  const isInstanceAdmin = roleAtLeast(user.role, 'admin')
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => isInstanceAdmin || !('instanceOnly' in item)),
  })).filter((group) => group.items.length > 0)

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SiteSwitcher canManage={isInstanceAdmin} />
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname === item.url}>
                    <NavLink to={item.url} className="font-medium">
                      {item.title}
                    </NavLink>
                  </SidebarMenuButton>

                  {/* The collections this site actually has, nested under the section. */}
                  {item.url === '/collections' &&
                    collections.data &&
                    collections.data.length > 0 && (
                      <SidebarMenuSub>
                        {collections.data.map((collection) => (
                          <SidebarMenuSubItem key={collection.id}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={pathname.startsWith(`/collections/${collection.slug}`)}
                            >
                              <NavLink to={`/collections/${collection.slug}`}>
                                {collection.name}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs capitalize opacity-70">{user.role}</span>
              </div>
              <LogOut className="ml-auto size-4" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

/** One deployment, many sites — this is how you move between them. */
function SiteSwitcher({ canManage }: { canManage: boolean }) {
  const { site, sites } = useActiveSite()
  const switchSite = useSwitchSite()
  const navigate = useNavigate()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Layers className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium">{site?.name ?? 'Hedge'}</span>
                <span className="truncate text-xs opacity-70">
                  {sites.length === 1 ? 'headless + edge CMS' : `${sites.length} sites`}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 opacity-70" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
            <DropdownMenuLabel className="text-muted-foreground text-xs">Sites</DropdownMenuLabel>
            {sites.map((option) => (
              <DropdownMenuItem key={option.id} onSelect={() => switchSite(option.slug)}>
                <span className="truncate">{option.name}</span>
                {option.slug === site?.slug && <Check className="ml-auto size-4" />}
              </DropdownMenuItem>
            ))}
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate('/settings/sites')}>
                  <Plus className="size-4" />
                  Manage sites
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
