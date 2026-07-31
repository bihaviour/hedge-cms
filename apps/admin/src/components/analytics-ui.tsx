import {
  ANALYTICS_RANGE_PRESETS,
  ANALYTICS_SCRIPT_PATH,
  type AnalyticsTotal,
  type ReferrerGroup,
} from '@hedge/core'
import { Minus, TrendingDown, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n/catalog'
import { cn } from '@/lib/utils'

/** Pieces the dashboard and `/analytics` both use, so the two screens say the same things. */

/**
 * A number and what it was last period.
 *
 * The comparison is not decoration: a headline figure with nothing beside it cannot be acted on,
 * and the first thing anybody asks of one is "is that a lot?".
 */
export function StatTile({
  label,
  total,
  chart,
}: {
  label: string
  total: AnalyticsTotal
  chart?: ReactNode
}) {
  const t = useT()

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-medium text-muted-foreground text-sm">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-3">
          <span className="font-semibold text-2xl tabular-nums tracking-tight">
            {total.value.toLocaleString()}
          </span>
          <Trend current={total.value} previous={total.previous} />
        </div>
        <p className="mt-1 text-muted-foreground text-xs">{t('analytics.comparedTo')}</p>
        {chart && <div className="mt-3">{chart}</div>}
      </CardContent>
    </Card>
  )
}

/**
 * Change against the previous period, as a percentage where one is meaningful.
 *
 * Growth from zero has no percentage — "+∞%" is not a number anybody can use — so it is shown as the
 * raw gain instead. The arrow and the sign both carry the direction, so the colour is never the only
 * thing saying which way it went.
 */
export function Trend({ current, previous }: { current: number; previous: number }) {
  const delta = current - previous
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus

  const label =
    previous === 0
      ? delta === 0
        ? '—'
        : `+${delta.toLocaleString()}`
      : `${delta > 0 ? '+' : ''}${Math.round((delta / previous) * 100)}%`

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-medium text-xs tabular-nums',
        delta > 0 && 'text-chart-2',
        delta < 0 && 'text-chart-3',
        delta === 0 && 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  )
}

const PRESET_LABEL: Record<number, MessageKey> = {
  7: 'analytics.range7',
  30: 'analytics.range30',
  90: 'analytics.range90',
  365: 'analytics.range365',
}

/**
 * The range picker. It sends a number of days, never two dates.
 *
 * Turning "the last 30 days" into a window needs to know where the site's day ends, and the browser
 * does not — its clock is the viewer's. The server cuts the days, in the site's timezone, for every
 * screen at once.
 */
export function RangePicker({
  days,
  onChange,
}: {
  days: number
  onChange: (days: number) => void
}) {
  const t = useT()

  return (
    <Select value={String(days)} onValueChange={(value) => onChange(Number(value))}>
      <SelectTrigger className="w-44" aria-label={t('analytics.rangeLabel')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ANALYTICS_RANGE_PRESETS.map((preset) => (
          <SelectItem key={preset} value={String(preset)}>
            {t(PRESET_LABEL[preset] ?? 'analytics.range30')}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export const REFERRER_GROUP_LABEL: Record<ReferrerGroup, MessageKey> = {
  search: 'analytics.groupSearch',
  social: 'analytics.groupSocial',
  direct: 'analytics.groupDirect',
  other: 'analytics.groupOther',
}

/** The one-line snippet a website embeds. Built from the admin's own origin, which is the Worker's. */
export function collectorSnippet(siteSlug: string | undefined): string {
  const origin = window.location.origin
  const site = siteSlug ? ` data-site="${siteSlug}"` : ''
  return `<script src="${origin}${ANALYTICS_SCRIPT_PATH}"${site} defer></script>`
}

/**
 * What a site with no data is shown.
 *
 * This is every deployment before the snippet is embedded, and it matters more than it sounds: an
 * empty chart looks exactly like a website nobody visited, and the two mean completely different
 * things. Saying which one it is, and how to fix it, is the whole job.
 */
export function CollectorEmptyState({ siteSlug }: { siteSlug: string | undefined }) {
  const t = useT()
  const snippet = collectorSnippet(siteSlug)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('analytics.notCollectingTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t('analytics.notCollectingBody')}
        </p>

        <div className="space-y-2">
          <p className="font-medium text-sm">{t('analytics.snippetTitle')}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
            <code>{snippet}</code>
          </pre>
          <p className="text-muted-foreground text-xs">{t('analytics.snippetHint')}</p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(snippet)
            toast.success(t('analytics.snippetCopied'))
          }}
        >
          {t('analytics.copySnippet')}
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * A caveat printed next to the numbers it applies to.
 *
 * Deliberately in the UI rather than in a commit message: a figure labelled "shares" that an
 * operator reads as "times this was shared on X" is a figure that will be quoted in a meeting, and
 * the only place to stop that is where the figure is read.
 */
export function Caveat({ children }: { children: ReactNode }) {
  return <p className="max-w-3xl text-muted-foreground text-xs leading-relaxed">{children}</p>
}
