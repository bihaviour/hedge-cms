import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { useFormatters, useT } from '@/lib/i18n'

/**
 * The security surface an operator manages rather than a preference they set: the browser sessions
 * signed in as them and the MCP clients allowed to act as them. Split out of the Account page and
 * into its own Settings entry — these are the levers you reach for when something is wrong, not
 * settings you tune day to day.
 */
export function AdminPage() {
  const t = useT()
  return (
    <>
      <PageHeader title={t('admin.title')} description={t('admin.subtitle')} />
      <div className="flex flex-col gap-6 p-4">
        <Sessions />
        <AuthorizedClients />
      </div>
    </>
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
