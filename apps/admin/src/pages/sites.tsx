import { localeLabel, type Site, slugify } from '@hedge/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Globe, Languages, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { LocalizationFields, type LocalizationValue } from '@/components/localization-fields'
import { PageHeader } from '@/components/page-header'
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
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useActiveSite, useSwitchSite } from '@/hooks/use-site'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'

/** The browser's own timezone as the sensible default for a new site — falls back to UTC. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** One deployment, many websites. Each row here is an independent content namespace. */
export function SitesPage() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [localizing, setLocalizing] = useState<Site | null>(null)
  const queryClient = useQueryClient()
  const { site: active, sites, isLoading } = useActiveSite()
  const switchSite = useSwitchSite()

  const remove = useMutation({
    mutationFn: api.sites.remove,
    onSuccess: () => {
      queryClient.invalidateQueries()
      toast.success(t('sites.deleted'))
    },
    onError: (error) => toast.error(error.message),
  })

  const toggleSignup = useMutation({
    mutationFn: ({ slug, allowMemberSignup }: { slug: string; allowMemberSignup: boolean }) =>
      api.sites.update(slug, { allowMemberSignup }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sites'] }),
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title={t('sites.title')}
        description={t('sites.subtitle')}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            {t('sites.new')}
          </Button>
        }
      />

      <div className="p-8">
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('sites.colName')}</TableHead>
                  <TableHead className="w-40">{t('sites.colSlug')}</TableHead>
                  <TableHead>{t('sites.colDomain')}</TableHead>
                  <TableHead className="w-48">{t('sites.colLocales')}</TableHead>
                  <TableHead className="w-32">{t('sites.colMemberSignup')}</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((site) => (
                  <SiteRow
                    key={site.id}
                    site={site}
                    isActive={site.slug === active?.slug}
                    canDelete={sites.length > 1}
                    onSwitch={() => switchSite(site.slug)}
                    onToggleSignup={(allowMemberSignup) =>
                      toggleSignup.mutate({ slug: site.slug, allowMemberSignup })
                    }
                    onLocalize={() => setLocalizing(site)}
                    onDelete={() => remove.mutate(site.slug)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <NewSiteDialog open={open} onOpenChange={setOpen} />
      <LocalizationDialog site={localizing} onOpenChange={(next) => !next && setLocalizing(null)} />
    </>
  )
}

function SiteRow({
  site,
  isActive,
  canDelete,
  onSwitch,
  onToggleSignup,
  onLocalize,
  onDelete,
}: {
  site: Site
  isActive: boolean
  canDelete: boolean
  onSwitch: () => void
  onToggleSignup: (allow: boolean) => void
  onLocalize: () => void
  onDelete: () => void
}) {
  const t = useT()
  return (
    <TableRow>
      <TableCell className="font-medium">
        {site.name}
        {isActive && (
          <Badge variant="secondary" className="ml-2">
            <Check className="size-3" />
            {t('sites.current')}
          </Badge>
        )}
        {site.description && <p className="text-muted-foreground text-xs">{site.description}</p>}
      </TableCell>
      <TableCell className="font-mono text-muted-foreground text-xs">{site.slug}</TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {site.domain ? (
          <span className="inline-flex items-center gap-1.5">
            <Globe className="size-3.5" />
            {site.domain}
          </span>
        ) : (
          t('common.none')
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <div className="flex flex-wrap items-center gap-1">
          {site.locales.map((code) => (
            <Badge
              key={code}
              variant={code === site.defaultLocale ? 'default' : 'outline'}
              className="font-normal"
              title={localeLabel(code)}
            >
              {code}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <Switch
          checked={site.allowMemberSignup}
          aria-label={t('sites.allowSignupAria', { name: site.name })}
          onCheckedChange={onToggleSignup}
        />
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('sites.localizationAria', { name: site.name })}
            title={t('sites.localization')}
            onClick={onLocalize}
          >
            <Languages className="size-4" />
          </Button>
          {!isActive && (
            <Button variant="outline" size="sm" onClick={onSwitch}>
              {t('sites.switch')}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('sites.deleteAria', { name: site.name })}
              onClick={() => {
                if (confirm(t('sites.deleteConfirm', { name: site.name }))) {
                  onDelete()
                }
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

/** Edits an existing site's per-site i18n config: content locales, default locale, timezone. */
function LocalizationDialog({
  site,
  onOpenChange,
}: {
  site: Site | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [value, setValue] = useState<LocalizationValue | null>(null)

  // Seed the form from the site the moment the dialog is asked to open for one.
  const current: LocalizationValue | null =
    value ??
    (site
      ? { locales: site.locales, defaultLocale: site.defaultLocale, timezone: site.timezone }
      : null)

  const save = useMutation({
    mutationFn: () => api.sites.update(site!.slug, current!),
    onSuccess: () => {
      queryClient.invalidateQueries()
      toast.success(t('sites.localizationSaved'))
      close()
    },
    onError: (error) => toast.error(error.message),
  })

  function close() {
    setValue(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={Boolean(site)} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sites.localizationTitle')}</DialogTitle>
          <DialogDescription>{t('sites.localizationDescription')}</DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {current && <LocalizationFields value={current} onChange={setValue} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NewSiteDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', slug: '', domain: '' })
  const [i18n, setI18n] = useState<LocalizationValue>({
    locales: ['en'],
    defaultLocale: 'en',
    timezone: browserTimezone(),
  })

  function reset() {
    setForm({ name: '', slug: '', domain: '' })
    setI18n({ locales: ['en'], defaultLocale: 'en', timezone: browserTimezone() })
  }

  const create = useMutation({
    mutationFn: api.sites.create,
    onSuccess: (site) => {
      queryClient.invalidateQueries({ queryKey: ['sites'] })
      toast.success(t('common.created', { name: site.name }))
      onOpenChange(false)
      reset()
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate({
              name: form.name,
              slug: form.slug || slugify(form.name),
              domain: form.domain || null,
              allowMemberSignup: true,
              ...i18n,
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('sites.newTitle')}</DialogTitle>
            <DialogDescription>{t('sites.newDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="site-name">{t('sites.fieldName')}</Label>
              <Input
                id="site-name"
                required
                placeholder="Documentation"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-slug">{t('sites.fieldSlug')}</Label>
              <Input
                id="site-slug"
                value={form.slug}
                placeholder={slugify(form.name) || 'documentation'}
                onChange={(event) => setForm({ ...form, slug: slugify(event.target.value) })}
              />
              <p className="text-muted-foreground text-xs">{t('sites.slugHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-domain">{t('sites.fieldDomain')}</Label>
              <Input
                id="site-domain"
                placeholder="docs.example.com"
                value={form.domain}
                onChange={(event) => setForm({ ...form, domain: event.target.value.trim() })}
              />
              <p className="text-muted-foreground text-xs">{t('sites.domainHint')}</p>
            </div>

            <div className="border-t pt-4">
              <LocalizationFields value={i18n} onChange={setI18n} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !form.name}>
              {t('sites.createSite')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
