import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { FormError } from '@/components/form-error'
import { PageHeader } from '@/components/page-header'
import { PasswordInput } from '@/components/password-input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { UI_LANGUAGES, useFormatters, useLanguageSetting, useT } from '@/lib/i18n'

/** Password, sessions, and the MCP clients allowed to act as this user. */
export function AccountPage() {
  const t = useT()
  return (
    <>
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />
      <div className="flex flex-col gap-6 p-4">
        <LanguagePreference />
        <ChangePassword />
        <Sessions />
        <AuthorizedClients />
      </div>
    </>
  )
}

/** The admin's display language — a per-browser preference, mirrored to the sidebar switcher. */
function LanguagePreference() {
  const t = useT()
  const [language, setLanguage] = useLanguageSetting()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account.uiLanguage')}</CardTitle>
        <CardDescription>{t('account.uiLanguageHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UI_LANGUAGES.map((option) => (
              <SelectItem key={option.code} value={option.code}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  )
}

function ChangePassword() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const change = useMutation({
    mutationFn: api.auth.changePassword,
    onSuccess: () => {
      toast.success('Password changed. Every other session has been signed out.')
      setCurrentPassword('')
      setNewPassword('')
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Changing it signs out everywhere else — if the old one leaked, this is what ends it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-sm"
          onSubmit={(event) => {
            event.preventDefault()
            change.mutate({ currentPassword, newPassword })
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                required
                minLength={12}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>

            <FormError error={change.error} />

            <Field>
              <Button type="submit" disabled={change.isPending}>
                Change password
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}

function Sessions() {
  const { formatDateTime } = useFormatters()
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.auth.sessions })

  const revoke = useMutation({
    mutationFn: api.auth.revokeSession,
    onSuccess: () => {
      toast.success('Session ended')
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>
          Every browser signed in as you. End any you do not recognise.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Where</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.data?.map((session) => (
              <TableRow key={session.id}>
                <TableCell className="max-w-xs truncate">
                  {session.ipAddress ?? 'Unknown address'}
                  {session.current && (
                    <span className="ml-2 text-muted-foreground text-xs">this browser</span>
                  )}
                  <div className="truncate text-muted-foreground text-xs">
                    {session.userAgent ?? '—'}
                  </div>
                </TableCell>
                <TableCell>{formatDateTime(session.createdAt)}</TableCell>
                <TableCell>{formatDateTime(session.expiresAt)}</TableCell>
                <TableCell className="text-right">
                  {!session.current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(session.id)}
                    >
                      End
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function AuthorizedClients() {
  const { formatDateTime } = useFormatters()
  const queryClient = useQueryClient()
  const clients = useQuery({ queryKey: ['oauth-clients'], queryFn: api.auth.oauthClients })

  const revoke = useMutation({
    mutationFn: api.auth.revokeOauthClient,
    onSuccess: () => {
      toast.success('Access revoked')
      queryClient.invalidateQueries({ queryKey: ['oauth-clients'] })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected clients</CardTitle>
        <CardDescription>
          MCP clients you approved. They act as you, limited by your role and what you granted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {clients.data?.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing is connected.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Approved</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.data?.map((client) => (
                <TableRow key={client.clientId}>
                  <TableCell>{client.name}</TableCell>
                  <TableCell>{formatDateTime(client.authorizedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(client.clientId)}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
