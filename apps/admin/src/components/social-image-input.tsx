import { useState } from 'react'
import { MediaPicker } from '@/components/media-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useMediaPreviewUrl } from '@/hooks/use-media-url'
import { useT } from '@/lib/i18n'

/**
 * The `ogImage` control, shared by the entry editor and site settings — the same field in both
 * places, and previously the same problem: a box labelled "Media key or URL" that someone typed
 * from memory, with no way to see what they had chosen.
 *
 * The stored value is still a key or a URL, because that is what the metadata schema holds; the
 * delivery API resolves it to an absolute URL, which is the only form Open Graph accepts.
 */
export function SocialImageInput({
  id,
  value,
  onChange,
}: {
  id: string
  value: string | undefined
  onChange: (value: string | undefined) => void
}) {
  const t = useT()
  const previewUrl = useMediaPreviewUrl()
  const [picking, setPicking] = useState(false)
  const src = value ? previewUrl(value) : null

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('meta.socialImage')}</Label>
      <div className="flex items-start gap-2">
        {src && (
          <img
            src={src}
            alt=""
            className="size-9 shrink-0 rounded border bg-muted object-cover"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden'
            }}
          />
        )}
        <Input
          id={id}
          className="min-w-0 flex-1"
          placeholder={t('meta.socialImagePlaceholder')}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
        <Button type="button" variant="outline" onClick={() => setPicking(true)}>
          {t('common.choose')}
        </Button>
      </div>

      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        accept={['image/*']}
        onConfirm={(items) => onChange(items[0]?.key)}
      />
    </div>
  )
}
