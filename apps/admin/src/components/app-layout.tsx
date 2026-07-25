import type { User } from '@hedge/core'
import { Fragment } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { AppSidebar } from '@/components/app-sidebar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { useActiveSite } from '@/hooks/use-site'

const LABELS: Record<string, string> = {
  collections: 'Collections',
  media: 'Media',
  members: 'Members',
  settings: 'Settings',
  sites: 'Sites',
  users: 'Users',
  'api-keys': 'API keys',
  entries: 'Entries',
  new: 'New',
}

const titleCase = (segment: string) =>
  LABELS[segment] ??
  segment.replace(/-/g, ' ').replace(/^./, (character) => character.toUpperCase())

export function AppLayout({ user }: { user: User }) {
  const { pathname } = useLocation()
  const { site } = useActiveSite()

  // The trail always starts at the site, so it is obvious which tenant you are editing.
  const segments = pathname.split('/').filter(Boolean)
  const crumbs = segments.map((segment, index) => ({
    label: titleCase(segment),
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
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
