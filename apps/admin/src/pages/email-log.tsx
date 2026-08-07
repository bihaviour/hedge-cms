import { DEFAULT_EMAIL_TEMPLATES, type EmailLog, type EmailStatus } from '@hedge/core'
import { EmptyState, PageHeader } from '@/components/page-header'
import { TablePagination } from '@/components/table-pagination'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useKeysetPage } from '@/hooks/use-paged-query'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/i18n'

const STATUS_VARIANT: Record<EmailStatus, 'default' | 'secondary' | 'destructive'> = {
  sent: 'default',
  skipped: 'secondary',
  failed: 'destructive',
}

function templateLabel(key: EmailLog['templateKey']): string {
  return key ? DEFAULT_EMAIL_TEMPLATES[key].label : '—'
}

export function EmailLogPage() {
  const { formatDate } = useFormatters()
  const log = useKeysetPage<EmailLog>({
    queryKey: ['email-log'],
    fetchPage: (page) => api.email.log(page),
  })

  const rows = log.rows

  return (
    <>
      <PageHeader
        title="Email log"
        description="Every email Hedge has composed, and whether it was sent, skipped, or rejected."
      />

      <div className="p-8">
        {log.isLoading && <Skeleton className="h-64 w-full" />}

        {!log.isLoading && log.isEmpty && (
          <EmptyState
            title="No emails yet"
            description="Invites, password resets and verification emails will appear here once sent."
          />
        )}

        {!log.isLoading && !log.isEmpty && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Status</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="w-44">Template</TableHead>
                  <TableHead className="w-40">Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[entry.status]}>{entry.status}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">{entry.to}</TableCell>
                    <TableCell>
                      <span className="line-clamp-1">{entry.subject}</span>
                      {entry.error && (
                        <span className="line-clamp-1 text-destructive text-xs">{entry.error}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {templateLabel(entry.templateKey)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(entry.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TablePagination state={log.pagination} />
          </div>
        )}
      </div>
    </>
  )
}
