import { useMutation } from '@tanstack/react-query'
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
import { api } from '@/lib/api'
import { UI_LANGUAGES, useLanguageSetting, useT } from '@/lib/i18n'

/**
 * Your own profile: the admin's display language and your password. Sessions and the MCP clients
 * that can act as you live under Settings → Admin, alongside the rest of the security surface.
 */
export function AccountPage() {
  const t = useT()
  return (
    <>
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />
      <div className="flex flex-col gap-6 p-4">
        <LanguagePreference />
        <ChangePassword />
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
