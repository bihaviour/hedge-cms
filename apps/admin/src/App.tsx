import { Navigate, Route, Routes } from 'react-router'
import { AppLayout } from '@/components/app-layout'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession, useSetupRequired } from '@/hooks/use-session'
import { AcceptInvitePage } from '@/pages/accept-invite'
import { ApiKeysPage } from '@/pages/api-keys'
import { CollectionSettingsPage } from '@/pages/collection-settings'
import { CollectionsPage } from '@/pages/collections'
import { EntriesPage } from '@/pages/entries'
import { EntryEditorPage } from '@/pages/entry-editor'
import { LoginPage } from '@/pages/login'
import { MediaPage } from '@/pages/media'
import { SetupPage } from '@/pages/setup'
import { UsersPage } from '@/pages/users'

export function App() {
  const session = useSession()
  const setup = useSetupRequired()

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
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }

  if (!session.data) {
    return (
      <Routes>
        {publicRoutes}
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
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
        <Route path="/settings/users" element={<UsersPage />} />
        <Route path="/settings/api-keys" element={<ApiKeysPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/collections" replace />} />
    </Routes>
  )
}
