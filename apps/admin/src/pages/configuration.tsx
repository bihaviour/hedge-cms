import { useState } from 'react'
import { useSession } from '@/hooks/use-session'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n/catalog'
import { cn } from '@/lib/utils'
import { ApiKeysPage } from '@/pages/api-keys'
import { EmailSettingsPage } from '@/pages/email-settings'
import { SiteSettingsPage } from '@/pages/site-settings'

type TabId = 'overview' | 'api' | 'email'

/**
 * One home for what used to be three separate nav entries: the per-site metadata, custom fields and
 * sender (Overview), this site's delivery keys (API), and the deployment-wide email sender (Email).
 * Each tab reuses its original page whole, header and all — so the pages stay usable in isolation
 * and this is only the shell that switches between them.
 *
 * The Email tab manages the deployment, not a site, so it appears only for those who can manage
 * email — the same `email:manage` gate the standalone Email settings entry carried in the sidebar.
 * Overview and API are site-scoped and open to whoever holds the site role.
 */
export function ConfigurationPage() {
  const t = useT()
  const session = useSession()
  const canManageEmail = session.data?.permissions.includes('email:manage') ?? false

  const tabs: { id: TabId; label: MessageKey }[] = [
    { id: 'overview', label: 'config.tabOverview' },
    { id: 'api', label: 'config.tabApi' },
    ...(canManageEmail ? [{ id: 'email' as TabId, label: 'config.tabEmail' as MessageKey }] : []),
  ]

  const [tab, setTab] = useState<TabId>('overview')
  // A viewer who loses the Email tab (role changed under them) falls back to Overview rather than a
  // blank pane.
  const active = tabs.some((entry) => entry.id === tab) ? tab : 'overview'

  return (
    <>
      <div className="flex gap-1 border-b px-8 pt-3">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 font-medium text-sm transition-colors',
              active === entry.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>

      {active === 'overview' && <SiteSettingsPage />}
      {active === 'api' && <ApiKeysPage />}
      {active === 'email' && canManageEmail && <EmailSettingsPage />}
    </>
  )
}
