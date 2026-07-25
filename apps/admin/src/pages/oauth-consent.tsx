import { useMutation, useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { decideConsent, describeScopes } from '@/lib/oauth'

/**
 * Approval for an MCP client that asked to act as this user.
 *
 * The API forces every authorization request through here, whether or not the client asked for a
 * consent prompt — a token that acts as an admin should never be issued by a redirect the operator
 * did not read.
 */
export function OAuthConsentPage() {
  const [params] = useSearchParams()
  const consentCode = params.get('consent_code') ?? ''
  const clientId = params.get('client_id') ?? ''
  const scopes = describeScopes(params.get('scope'))

  const client = useQuery({
    queryKey: ['oauth-client', clientId],
    queryFn: () => api.auth.oauthPending(clientId),
    enabled: Boolean(clientId),
  })

  const decide = useMutation({
    mutationFn: (accept: boolean) => decideConsent(consentCode, accept),
  })

  if (!consentCode || !clientId) {
    return (
      <Shell>
        <CardHeader>
          <CardTitle>Nothing to approve</CardTitle>
          <CardDescription>
            This page opens by itself when an MCP client asks for access.
          </CardDescription>
        </CardHeader>
      </Shell>
    )
  }

  return (
    <Shell>
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-muted">
          <ShieldCheck className="size-5" />
        </div>
        <CardTitle className="text-xl">
          Allow {client.data?.name ?? 'this client'} to act as you?
        </CardTitle>
        <CardDescription>
          It will be able to do the following in Hedge, limited by what your own role allows.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <ul className="flex flex-col gap-2 text-sm">
          {scopes.map((scope) => (
            <li key={scope} className="flex gap-2">
              <span aria-hidden className="text-muted-foreground">
                •
              </span>
              <span>{scope}</span>
            </li>
          ))}
        </ul>

        {decide.error && (
          <p className="text-destructive text-sm">{(decide.error as Error).message}</p>
        )}

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
          >
            Deny
          </Button>
          <Button
            className="flex-1"
            disabled={decide.isPending}
            onClick={() => decide.mutate(true)}
          >
            Allow
          </Button>
        </div>

        <p className="text-center text-muted-foreground text-xs">
          You can end this access at any time from Settings → Account.
        </p>
      </CardContent>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  )
}
