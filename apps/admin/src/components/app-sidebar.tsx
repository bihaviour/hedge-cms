import type { InstancePermission, User } from '@hedge/core'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowUpCircle,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Languages,
  Layers,
  LogOut,
  Plus,
  SunMoon,
  UserRound,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import type * as React from 'react'
import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  SidebarMenuBadge,
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
import { UI_LANGUAGES, useLanguageSetting, useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n/catalog'
import { cn } from '@/lib/utils'

/** Your own profile and credentials. Reached from the account menu in the footer, not from the nav. */
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
 * An item with a `permission` is managing the deployment rather than a site, so it is hidden from
 * anyone whose role does not carry that permission — the API would refuse them anyway, and offering
 * a door that does not open is worse than not showing it. Items without one are site-level (like
 * Configuration, whose tabs are gated by the *site* role a per-site admin can hold) and show for
 * everyone. UI gating is cosmetic; the server check is the real one.
 */
const NAV: {
  title: MessageKey
  items: { title: MessageKey; url: string; permission?: InstancePermission }[]
}[] = [
  {
    title: 'nav.content',
    items: [
      { title: 'nav.collections', url: '/collections' },
      { title: 'nav.review', url: '/review' },
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
    title: 'nav.communication',
    items: [
      { title: 'nav.emailTemplates', url: '/settings/email/templates', permission: 'email:manage' },
      { title: 'nav.emailLog', url: '/settings/email/log', permission: 'email:manage' },
    ],
  },
  {
    title: 'nav.settings',
    items: [
      // Site metadata (Overview), delivery keys (API) and the deployment sender (Email), tabbed.
      { title: 'nav.configuration', url: '/settings/configuration' },
      { title: 'nav.sites', url: '/settings/sites', permission: 'sites:create' },
      { title: 'nav.users', url: '/settings/users', permission: 'users:manage' },
      // Define the roles that users can be assigned, and the permissions each carries.
      { title: 'nav.roles', url: '/settings/roles', permission: 'roles:manage' },
    ],
  },
]

export function AppSidebar({
  user,
  ...props
}: { user: User } & React.ComponentProps<typeof Sidebar>) {
  const siteSlug = useActiveSiteSlug()
  const collections = useQuery({
    queryKey: ['collections', siteSlug],
    queryFn: api.collections.list,
    enabled: Boolean(siteSlug),
  })

  /**
   * How many versions are waiting on this person. Polled on TanStack Query's existing cadence
   * rather than by adding any transport — a queue badge is a nudge, and a self-hosted CMS's review
   * volume does not justify a socket. A viewer gets a 403 here, which is simply no badge.
   */
  const reviewCount = useQuery({
    queryKey: ['review-count', siteSlug],
    queryFn: api.review.count,
    enabled: Boolean(siteSlug),
    retry: false,
    refetchInterval: 60_000,
  })

  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.permission || user.permissions.includes(item.permission),
    ),
  })).filter((group) => group.items.length > 0)

  // Creating a site is the power the switcher's "manage sites" shortcut leads to.
  const canManageSites = user.permissions.includes('sites:create')

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SiteSwitcher canManage={canManageSites} />
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <NavGroup
            key={group.title}
            group={group}
            collections={collections.data ?? []}
            reviewCount={reviewCount.data?.count ?? 0}
          />
        ))}
      </SidebarContent>

      <SidebarFooter>
        <UserMenu user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

/**
 * One nav section, collapsible so a long portal can be tidied section by section. Open by default —
 * the sections are the map of the app, and hiding them all on first load would bury it.
 */
function NavGroup({
  group,
  collections,
  reviewCount,
}: {
  group: (typeof NAV)[number]
  collections: { id: string; slug: string; name: string }[]
  reviewCount: number
}) {
  const t = useT()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(true)

  return (
    <SidebarGroup>
      <SidebarGroupLabel asChild>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex w-full items-center justify-between transition-colors hover:text-sidebar-foreground"
        >
          {t(group.title)}
          <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
        </button>
      </SidebarGroupLabel>

      {open && (
        <SidebarMenu>
          {group.items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton asChild isActive={pathname === item.url}>
                <NavLink to={item.url} className="font-medium">
                  {t(item.title)}
                </NavLink>
              </SidebarMenuButton>

              {/* Visible without navigating to it, which is the whole point of a queue. */}
              {item.url === '/review' && reviewCount > 0 && (
                <SidebarMenuBadge>{reviewCount}</SidebarMenuBadge>
              )}

              {/* The collections this site actually has, nested under the section. */}
              {item.url === '/collections' && collections.length > 0 && (
                <SidebarMenuSub>
                  {collections.map((collection) => (
                    <SidebarMenuSubItem key={collection.id}>
                      <SidebarMenuSubButton
                        asChild
                        isActive={pathname.startsWith(`/collections/${collection.slug}`)}
                      >
                        <NavLink to={`/collections/${collection.slug}`}>{collection.name}</NavLink>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  )
}

/**
 * The account menu in the footer: who you are, plus the preferences and account actions that belong
 * to the person rather than the site — display language, theme, the update notice and signing out.
 * These are deliberately behind one click: they are rarely-changed settings, not primary nav, and
 * grouping them keeps sign-out from sitting a stray tap away from everything else.
 */
function UserMenu({ user }: { user: User }) {
  const t = useT()
  const navigate = useNavigate()
  const logout = useLogout()
  const [language, setLanguage] = useLanguageSetting()
  const { theme, setTheme } = useTheme()
  // The update notice is a manage-the-deployment concern, shown to whoever can read system status.
  const canSeeUpdates = user.permissions.includes('system:read')

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label={user.name}>
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs opacity-70">{user.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 opacity-70" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side="right"
            align="end"
            sideOffset={8}
            className="min-w-56 rounded-lg"
          >
            {/* The profile header doubles as the way into your account — clicking it lands on the
                same page as the Account item below. */}
            <DropdownMenuItem className="gap-2 p-2" onSelect={() => navigate(ACCOUNT_PATH)}>
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium text-sm">{user.name}</span>
                <span className="truncate text-muted-foreground text-xs">{user.email}</span>
              </div>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={() => navigate(ACCOUNT_PATH)}>
              <UserRound />
              {t('nav.account')}
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Languages />
                {t('language.label')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={language} onValueChange={setLanguage}>
                  {UI_LANGUAGES.map((option) => (
                    <DropdownMenuRadioItem key={option.code} value={option.code}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SunMoon />
                {t('theme.label')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">{t('theme.light')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">{t('theme.dark')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">{t('theme.system')}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Deployment version and update awareness — a manage-the-deployment concern, so only
                instance admins see it, matching the old About & updates nav entry. */}
            {canSeeUpdates && (
              <DropdownMenuItem onSelect={() => navigate('/settings/about')}>
                <ArrowUpCircle />
                {t('nav.updates')}
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />

            <DropdownMenuItem
              variant="destructive"
              disabled={logout.isPending}
              onSelect={(event) => {
                // Keep the menu from closing before the mutation is even fired.
                event.preventDefault()
                logout.mutate()
              }}
            >
              <LogOut />
              {t('nav.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
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
