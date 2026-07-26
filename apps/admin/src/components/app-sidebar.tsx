import { roleAtLeast, type User } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Layers, LogOut, Plus } from 'lucide-react'
import type * as React from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { LanguageSwitcher } from '@/components/language-switcher'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
  SidebarMenuAction,
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
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n/catalog'

/** Your own profile and credentials. Reached from the footer, not from the nav. */
const ACCOUNT_PATH = '/settings/account'

/** Up to two letters, so a long name and a mononym both come out the same size. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? [parts[0]!, parts.at(-1)!] : [parts[0] ?? '?']
  return letters
    .map((part) => part[0]!.toUpperCase())
    .join('')
    .slice(0, 2)
}

/**
 * Static nav. Collections fills its sub-items from the API; everything else is fixed.
 *
 * `instanceOnly` items are managing the deployment rather than a site, so they are hidden from
 * editors and viewers — the API would refuse them anyway, and offering a door that does not open
 * is worse than not showing it. API keys stays: it is gated by the *site* role, which a
 * per-site admin can hold without being an instance admin.
 */
const NAV: {
  title: MessageKey
  items: { title: MessageKey; url: string; instanceOnly?: boolean }[]
}[] = [
  {
    title: 'nav.content',
    items: [
      { title: 'nav.collections', url: '/collections' },
      { title: 'nav.media', url: '/media' },
    ],
  },
  {
    title: 'nav.audience',
    items: [
      { title: 'nav.members', url: '/members' },
      { title: 'nav.newsletters', url: '/newsletters' },
      { title: 'nav.newsletterTemplates', url: '/newsletters/templates' },
      { title: 'nav.subscribers', url: '/subscribers' },
    ],
  },
  {
    title: 'nav.email',
    items: [
      { title: 'nav.emailSettings', url: '/settings/email', instanceOnly: true },
      { title: 'nav.emailTemplates', url: '/settings/email/templates', instanceOnly: true },
      { title: 'nav.emailLog', url: '/settings/email/log', instanceOnly: true },
    ],
  },
  {
    title: 'nav.settings',
    items: [
      { title: 'nav.siteSettings', url: '/settings/site' },
      { title: 'nav.sites', url: '/settings/sites', instanceOnly: true },
      { title: 'nav.users', url: '/settings/users', instanceOnly: true },
      { title: 'nav.apiKeys', url: '/settings/api-keys' },
    ],
  },
]

export function AppSidebar({
  user,
  ...props
}: { user: User } & React.ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation()
  const t = useT()
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
            <SidebarGroupLabel>{t(group.title)}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname === item.url}>
                    <NavLink to={item.url} className="font-medium">
                      {t(item.title)}
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
        <LanguageSwitcher />
        <SidebarMenu>
          {/*
            The profile bar is a link to your own account, not a menu: the one thing it does
            besides that is sign out, and that needs its own button — leaving on the way to
            changing a password is exactly the accident this avoids.
          */}
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild isActive={pathname === ACCOUNT_PATH}>
              <NavLink to={ACCOUNT_PATH}>
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs opacity-70">{user.email}</span>
                </div>
              </NavLink>
            </SidebarMenuButton>

            <SidebarMenuAction
              className="top-1/2 -translate-y-1/2"
              aria-label={t('nav.signOut')}
              title={t('nav.signOut')}
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              <LogOut />
            </SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

/** One deployment, many sites — this is how you move between them. */
function SiteSwitcher({ canManage }: { canManage: boolean }) {
  const t = useT()
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
                  {sites.length === 1
                    ? t('nav.sitesTagline')
                    : t('nav.siteCount', { count: sites.length })}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 opacity-70" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {t('nav.sites')}
            </DropdownMenuLabel>
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
                  {t('nav.manageSites')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
