import type { Subscriber } from '@hedge/core'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/i18n'

export function NewsletterSubscribersPage() {
  const { formatDate } = useFormatters()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const queryClient = useQueryClient()
  const siteSlug = useActiveSiteSlug()

  const subscribers = useInfiniteQuery({
    queryKey: ['subscribers', siteSlug, search],
    queryFn: ({ pageParam }) => api.subscribers.list({ q: search || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(siteSlug),
  })

  const rows = subscribers.data?.pages.flatMap((page) => page.data) ?? []

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['subscribers'] })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Subscriber['status'] }) =>
      api.subscribers.update(id, { status }),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: api.subscribers.remove,
    onSuccess: () => {
      invalidate()
      toast.success('Subscriber removed')
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title="Subscribers"
        description="The newsletter list for this site. People can also sign up from your website's own form."
        actions={
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="size-4" />
            Add subscriber
          </Button>
        }
      />

      <div className="space-y-4 p-8">
        <Input
          placeholder="Search by email…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />

        {subscribers.isLoading && <Skeleton className="h-48 w-full" />}

        {!subscribers.isLoading && rows.length === 0 && (
          <EmptyState
            title="No subscribers yet"
            description="Add someone manually, or embed a signup form that posts to the public subscribe endpoint."
            action={<Button onClick={() => setOpen(true)}>Add subscriber</Button>}
          />
        )}

        {rows.length > 0 && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="w-28">Source</TableHead>
                  <TableHead className="w-32">Added</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((subscriber) => (
                  <TableRow key={subscriber.id}>
                    <TableCell className="font-medium">{subscriber.email}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {subscriber.name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={subscriber.status === 'subscribed' ? 'default' : 'secondary'}>
                        {subscriber.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {subscriber.source ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(subscriber.createdAt)}
                    </TableCell>
                    <TableCell className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setStatus.mutate({
                            id: subscriber.id,
                            status:
                              subscriber.status === 'subscribed' ? 'unsubscribed' : 'subscribed',
                          })
                        }
                      >
                        {subscriber.status === 'subscribed' ? 'Unsubscribe' : 'Resubscribe'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${subscriber.email}`}
                        onClick={() => remove.mutate(subscriber.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {subscribers.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              disabled={subscribers.isFetchingNextPage}
              onClick={() => subscribers.fetchNextPage()}
            >
              {subscribers.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>

      <AddSubscriberDialog open={open} onOpenChange={setOpen} onAdded={invalidate} />
    </>
  )
}

function AddSubscriberDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: () => api.subscribers.create({ email, name: name || undefined }),
    onSuccess: () => {
      onAdded()
      onOpenChange(false)
      setEmail('')
      setName('')
      toast.success('Subscriber added')
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Add subscriber</DialogTitle>
            <DialogDescription>
              They are added straight to the list. Only add people who have agreed to hear from you.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="sub-email">Email</Label>
              <Input
                id="sub-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sub-name">Name (optional)</Label>
              <Input id="sub-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !email}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
