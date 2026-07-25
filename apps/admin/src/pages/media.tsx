import { MAX_UPLOAD_BYTES } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, Upload } from 'lucide-react'
import { useRef } from 'react'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useActiveSiteSlug } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/utils'

export function MediaPage() {
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const siteSlug = useActiveSiteSlug()
  const media = useQuery({
    queryKey: ['media', siteSlug],
    queryFn: () => api.media.list(),
    enabled: Boolean(siteSlug),
  })

  const upload = useMutation({
    mutationFn: (file: File) => api.media.upload(file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      toast.success('Uploaded')
    },
    onError: (error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: api.media.remove,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      toast.success('Deleted')
    },
  })

  return (
    <>
      <PageHeader
        title="Media"
        description={`Files stored in R2. Up to ${formatBytes(MAX_UPLOAD_BYTES)} each.`}
        actions={
          <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
            <Upload className="size-4" />
            Upload
          </Button>
        }
      />

      <input
        ref={fileInput}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) upload.mutate(file)
          event.target.value = ''
        }}
      />

      <div className="p-8">
        {media.isLoading && (
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[0, 1, 2, 3, 4].map((key) => (
              <Skeleton key={key} className="aspect-square" />
            ))}
          </div>
        )}

        {media.data?.data.length === 0 && (
          <EmptyState
            title="No files yet"
            description="Upload images and documents to reference them from your entries."
            action={<Button onClick={() => fileInput.current?.click()}>Upload a file</Button>}
          />
        )}

        {media.data && media.data.data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {media.data.data.map((item) => (
              <div key={item.id} className="group overflow-hidden rounded-lg border">
                <div className="flex aspect-square items-center justify-center bg-muted">
                  {item.contentType.startsWith('image/') ? (
                    <img
                      src={item.url}
                      alt={item.alt ?? item.filename}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-muted-foreground text-xs uppercase">
                      {item.contentType.split('/')[1]}
                    </span>
                  )}
                </div>
                <div className="flex items-start justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.filename}</p>
                    <p className="text-muted-foreground text-xs">{formatBytes(item.size)}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${item.filename}`}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => remove.mutate(item.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
