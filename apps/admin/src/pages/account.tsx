import { TRUSTED_DEVICE_TTL_DAYS } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { FormError } from '@/components/form-error'
import { PageHeader } from '@/components/page-header'
import { PasswordInput } from '@/components/password-input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
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

/**
 * Your own account: display language, password, and the security levers that are yours alone — the
 * browser sessions signed in as you, the browsers trusted to skip the sign-in code, and the MCP
 * clients allowed to act as you. All of it is per-user data, so it lives here rather than behind a
 * deployment-admin gate: an editor who lost a laptop still needs to end that session, forget that
 * device and revoke a client, and the account menu is the one door every operator has.
 */
export function AccountPage() {
  const t = useT()
  return (
    <>
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />
      <div className="flex flex-col gap-6 p-4">
        <LanguagePreference />
        <ChangePassword />
        <Sessions />
        <TrustedDevices />
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

/**
 * The password card. The form itself is behind a dialog rather than sitting open on the page: it is
 * a deliberate, occasional action, and an always-open pair of password fields on a settings page is
 * something browsers offer to autofill on every visit.
 */
function ChangePassword() {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Changing it signs out everywhere else and forgets every trusted browser — if the old one
          leaked, this is what ends it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Change password
        </Button>
      </CardContent>
      <ChangePasswordDialog open={open} onOpenChange={setOpen} />
    </Card>
  )
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const change = useMutation({
    mutationFn: api.auth.changePassword,
    onSuccess: () => {
      toast.success('Password changed. Every other session has been signed out.')
      setCurrentPassword('')
      setNewPassword('')
      onOpenChange(false)
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never leave a typed password sitting in state behind a closed dialog.
        if (!next) {
          setCurrentPassword('')
          setNewPassword('')
          change.reset()
        }
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            change.mutate({ currentPassword, newPassword })
          }}
        >
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              You stay signed in here. Every other session ends, and every browser you had trusted
              has to be verified by email again.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="py-4">
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
              <FieldDescription>At least 12 characters.</FieldDescription>
            </Field>

            <FormError error={change.error} />
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={change.isPending}>
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Browsers that skip the emailed sign-in code. Separate from "Active sessions" because they answer
 * different questions: a session is somewhere you are signed in *now*, a trusted device is somewhere
 * that will not be challenged *next time*. Ending one does not do the other.
 */
function TrustedDevices() {
  const { formatDateTime } = useFormatters()
  const queryClient = useQueryClient()
  const devices = useQuery({ queryKey: ['trusted-devices'], queryFn: api.auth.devices })

  const revoke = useMutation({
    mutationFn: api.auth.revokeDevice,
    onSuccess: () => {
      toast.success('Device forgotten. The next sign-in from it needs a code.')
      queryClient.invalidateQueries({ queryKey: ['trusted-devices'] })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trusted browsers</CardTitle>
        <CardDescription>
          These skip the emailed code at sign-in for {TRUSTED_DEVICE_TTL_DAYS} days. Forget any you
          do not recognise.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {devices.data?.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No browser is trusted — every sign-in is verified by email.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Browser</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Trusted until</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.data?.map((device) => (
                <TableRow key={device.id}>
                  <TableCell>
                    {device.label}
                    {device.current && (
                      <span className="ml-2 text-muted-foreground text-xs">this browser</span>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(device.lastUsedAt)}</TableCell>
                  <TableCell>{formatDateTime(device.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(device.id)}
                    >
                      Forget
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
