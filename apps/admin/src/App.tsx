import { OAUTH_CONSENT_PATH, roleAtLeast } from '@hedge/core'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { AppLayout } from '@/components/app-layout'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession, useSetupRequired } from '@/hooks/use-session'
import { useSites } from '@/hooks/use-site'
import { AcceptInvitePage } from '@/pages/accept-invite'
import { AccountPage } from '@/pages/account'
import { ApiKeysPage } from '@/pages/api-keys'
import { CollectionSettingsPage } from '@/pages/collection-settings'
import { CollectionsPage } from '@/pages/collections'
import { EmailLogPage } from '@/pages/email-log'
import { EmailSettingsPage } from '@/pages/email-settings'
import { EmailTemplatesPage } from '@/pages/email-templates'
import { EntriesPage } from '@/pages/entries'
import { EntryEditorPage } from '@/pages/entry-editor'
import { LoginPage } from '@/pages/login'
import { MediaPage } from '@/pages/media'
import { MembersPage } from '@/pages/members'
import { NewsletterSubscribersPage } from '@/pages/newsletter-subscribers'
import { NewsletterTemplatesPage } from '@/pages/newsletter-templates'
import { NewslettersPage } from '@/pages/newsletters'
import { OAuthConsentPage } from '@/pages/oauth-consent'
import { OnboardingPage } from '@/pages/onboarding'
import { SiteSettingsPage } from '@/pages/site-settings'
import { SitesPage } from '@/pages/sites'
import { UsersPage } from '@/pages/users'

export function App() {
  const session = useSession()
  const setup = useSetupRequired()
  const sites = useSites({ enabled: Boolean(session.data) })
  const location = useLocation()

  if (session.isLoading || setup.isLoading) {
    return (
      <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-3 p-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  // Token-based flows must stay reachable while signed out.
  const publicRoutes = (
    <>
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/reset-password" element={<AcceptInvitePage mode="reset" />} />
    </>
  )

  if (setup.data?.setupRequired) {
    return (
      <Routes>
        {publicRoutes}
        <Route path="/onboarding" element={<OnboardingPage hasAccount={false} />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    )
  }

  if (!session.data) {
    return (
      <Routes>
        {publicRoutes}
        <Route path="/login" element={<LoginPage />} />
        {/* Keep the query: an MCP client's authorization request is carried in it, and dropping
            it here would leave the client waiting on a callback that never arrives. */}
        <Route path="*" element={<Navigate to={`/login${location.search}`} replace />} />
      </Routes>
    )
  }

  /**
   * Setup that stopped after the account was made leaves an instance with nowhere to put content,
   * so the wizard is picked up where it was left rather than dropping the owner into an admin with
   * no site. Only for someone who can actually create one — an editor with no grants sees the app,
   * and an empty site switcher, which is the truth about their access rather than a wizard they
   * would be refused.
   */
  if (sites.data?.length === 0 && roleAtLeast(session.data.role, 'admin')) {
    return (
      <Routes>
        <Route path="*" element={<OnboardingPage hasAccount />} />
      </Routes>
    )
  }

  return (
    <Routes>
      {publicRoutes}
      <Route element={<AppLayout user={session.data} />}>
        <Route path="/" element={<Navigate to="/collections" replace />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/collections/:collection" element={<EntriesPage />} />
        <Route path="/collections/:collection/settings" element={<CollectionSettingsPage />} />
        <Route path="/collections/:collection/entries/new" element={<EntryEditorPage />} />
        <Route path="/collections/:collection/entries/:slug" element={<EntryEditorPage />} />
        <Route path="/media" element={<MediaPage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/newsletters" element={<NewslettersPage />} />
        <Route path="/newsletters/templates" element={<NewsletterTemplatesPage />} />
        <Route path="/subscribers" element={<NewsletterSubscribersPage />} />
        <Route path="/settings/site" element={<SiteSettingsPage />} />
        <Route path="/settings/sites" element={<SitesPage />} />
        <Route path="/settings/users" element={<UsersPage />} />
        <Route path="/settings/api-keys" element={<ApiKeysPage />} />
        <Route path="/settings/email" element={<EmailSettingsPage />} />
        <Route path="/settings/email/templates" element={<EmailTemplatesPage />} />
        <Route path="/settings/email/log" element={<EmailLogPage />} />
        <Route path="/settings/account" element={<AccountPage />} />
      </Route>
      {/* Outside the app shell: it is a decision to make, not a place to browse. */}
      <Route path={OAUTH_CONSENT_PATH} element={<OAuthConsentPage />} />
      <Route path="*" element={<Navigate to="/collections" replace />} />
    </Routes>
  )
}
