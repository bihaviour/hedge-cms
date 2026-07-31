import type { AnalyticsPoint, AudiencePoint } from '@hedge/core'
import { lazy, Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import type { TranslateFn } from '@/lib/i18n'

/**
 * The admin's charts.
 *
 * Recharts is the one charting dependency and it is a large one, so every chart in here is behind a
 * `lazy()` boundary: the bundle the Worker serves from `ASSETS` is the admin's whole cost, and a
 * chart library has no business loading for someone editing an entry. `chart-marks.tsx` holds the
 * recharts side, and is only ever reached through this file.
 *
 * These live in `src/components/` rather than `src/components/ui/`, which is shadcn CLI output and
 * excluded from linting — hand-writing a file there would claim a provenance it does not have.
 *
 * Conventions the three charts share, so they read as one system:
 *
 * - **One axis, always.** Two measures of different scale get two charts, never two y-scales.
 * - **The previous period is a reference, not a second series** — a thin dashed line in the muted
 *   text colour, so the eye reads the filled series first and the comparison second.
 * - **Colour never carries meaning alone.** Every mark's identity is also in a label or in its
 *   position, which is what lets the gained/against/lost pair stay legible without colour.
 */

const Marks = lazy(() => import('./chart-marks'))

function ChartFrame({ height, children }: { height: number; children: React.ReactNode }) {
  return (
    <Suspense fallback={<Skeleton style={{ height }} className="w-full" />}>
      <div style={{ height }} className="w-full">
        {children}
      </div>
    </Suspense>
  )
}

/**
 * Traffic over time, with the previous period behind it.
 *
 * `previous` is aligned by index rather than by date — it is a different stretch of calendar, and
 * the point of drawing it is shape against shape, not day against day.
 */
export function TrafficChart({
  series,
  previous,
  label,
  previousLabel,
  height = 240,
  compact = false,
  formatDate,
}: {
  series: AnalyticsPoint[]
  previous?: AnalyticsPoint[]
  label: string
  previousLabel?: string
  height?: number
  /** A sparkline: no axes, no grid, no legend. For a tile, where the shape is the whole message. */
  compact?: boolean
  formatDate: (value: string) => string
}) {
  return (
    <ChartFrame height={height}>
      <Marks
        kind="traffic"
        traffic={{ series, previous, label, previousLabel, compact, formatDate }}
      />
    </ChartFrame>
  )
}

/** A ranked bar chart: one measure, one hue. Identity is in the label beside each bar. */
export function RankedBars({
  rows,
  height = 240,
  valueLabel,
}: {
  rows: { label: string; value: number; note?: string }[]
  height?: number
  valueLabel: string
}) {
  return (
    <ChartFrame height={height}>
      <Marks kind="ranked" ranked={{ rows, valueLabel }} />
    </ChartFrame>
  )
}

/**
 * Subscribers gained against lost, per day.
 *
 * Losses are drawn below the baseline, so the sign is in the geometry and the colours only agree
 * with it — which is what keeps the pair readable for anyone who cannot tell the two hues apart.
 */
export function AudienceChart({
  points,
  t,
  formatDate,
  height = 220,
}: {
  points: AudiencePoint[]
  t: TranslateFn
  formatDate: (value: string) => string
  height?: number
}) {
  return (
    <ChartFrame height={height}>
      <Marks
        kind="audience"
        audience={{
          points,
          gainedLabel: t('analytics.subscribersGained'),
          lostLabel: t('analytics.subscribersLost'),
          formatDate,
        }}
      />
    </ChartFrame>
  )
}
