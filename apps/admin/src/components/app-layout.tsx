import { roleAtLeast, type User } from '@hedge/core'
import { Fragment } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { AppSidebar } from '@/components/app-sidebar'
import { EmptyState } from '@/components/page-header'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { useActiveSite } from '@/hooks/use-site'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n/catalog'

const LABELS: Record<string, MessageKey> = {
  collections: 'label.collections',
  media: 'label.media',
  members: 'label.members',
  newsletters: 'label.newsletters',
  subscribers: 'label.subscribers',
  settings: 'label.settings',
  sites: 'label.sites',
  users: 'label.users',
  'api-keys': 'label.apiKeys',
  email: 'label.email',
  templates: 'label.templates',
  log: 'label.log',
  entries: 'label.entries',
  new: 'label.new',
  account: 'label.account',
}

export function AppLayout({ user }: { user: User }) {
  const { pathname } = useLocation()
  const t = useT()
  const { site, sites, isLoading } = useActiveSite()

  // Known route segments read from the catalog; an unknown one (a slug) is title-cased as-is.
  const label = (segment: string) =>
    LABELS[segment]
      ? t(LABELS[segment])
      : segment.replace(/-/g, ' ').replace(/^./, (character) => character.toUpperCase())

  // The trail always starts at the site, so it is obvious which tenant you are editing.
  const segments = pathname.split('/').filter(Boolean)
  const crumbs = segments.map((segment, index) => ({
    label: label(segment),
    href: `/${segments.slice(0, index + 1).join('/')}`,
    isLast: index === segments.length - 1,
  }))

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbPage className="text-muted-foreground">
                  {site?.name ?? 'Hedge'}
                </BreadcrumbPage>
              </BreadcrumbItem>
              {crumbs.map((crumb) => (
                <Fragment key={crumb.href}>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem>
                    {crumb.isLast ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </header>

        <div className="min-w-0 flex-1">
          {/* An editor or viewer with no grants would otherwise stare at empty pages. */}
          {!isLoading && sites.length === 0 ? (
            <div className="p-8">
              <EmptyState
                title={t('sites.emptyTitle')}
                description={
                  roleAtLeast(user.role, 'admin') ? t('sites.emptyAdmin') : t('sites.emptyGuest')
                }
                action={
                  roleAtLeast(user.role, 'admin') ? (
                    <Button asChild>
                      <Link to="/settings/sites">{t('sites.goToSites')}</Link>
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <Outlet />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
