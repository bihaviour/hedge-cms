import type { AnalyticsPoint, AudiencePoint } from '@hedge/core'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

/**
 * The recharts half of the admin's charts. Reached only through `charts.tsx`, which lazy-loads it —
 * this module pulls in the whole charting library and must never land in the main bundle.
 *
 * Mark specs, applied consistently across all three: 2px lines, 4px rounded bar ends anchored to
 * the baseline, a recessive dashed grid, axes in the muted text colour, and a hover layer on every
 * chart. Series colours come from the `--chart-*` tokens in `index.css`, which is where the
 * light/dark steps and the reasoning behind them live.
 */

const AXIS = 'var(--muted-foreground)'
const GRID = 'var(--border)'

const axisProps = {
  stroke: AXIS,
  tickLine: false,
  axisLine: false,
  tick: { fill: AXIS, fontSize: 11 },
} as const

/** One tooltip style for every chart, so hovering feels like one surface rather than three. */
const tooltipProps = {
  cursor: { stroke: AXIS, strokeWidth: 1 },
  contentStyle: {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--popover-foreground)',
    fontSize: 12,
  },
  labelStyle: { color: 'var(--muted-foreground)' },
} as const

interface TrafficProps {
  series: AnalyticsPoint[]
  previous?: AnalyticsPoint[]
  label: string
  previousLabel?: string
  compact: boolean
  formatDate: (value: string) => string
}

interface RankedProps {
  rows: { label: string; value: number; note?: string }[]
  valueLabel: string
}

interface AudienceProps {
  points: AudiencePoint[]
  gainedLabel: string
  lostLabel: string
  formatDate: (value: string) => string
}

export default function Marks(props: {
  kind: 'traffic' | 'ranked' | 'audience'
  traffic?: TrafficProps
  ranked?: RankedProps
  audience?: AudienceProps
}) {
  if (props.kind === 'traffic' && props.traffic) return <Traffic {...props.traffic} />
  if (props.kind === 'ranked' && props.ranked) return <Ranked {...props.ranked} />
  if (props.kind === 'audience' && props.audience) return <Audience {...props.audience} />
  return null
}

function Traffic({ series, previous, label, previousLabel, compact, formatDate }: TrafficProps) {
  // The comparison is aligned by index: it covers a different stretch of calendar, and what is
  // being compared is the shape of the period, not one date against another.
  const data = series.map((point, index) => ({
    date: point.date,
    current: point.count,
    previous: previous?.[index]?.count ?? null,
  }))

  const hasComparison = Boolean(previous?.length) && !compact

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: compact ? 0 : -16 }}>
        <defs>
          <linearGradient id="hedge-traffic-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {!compact && <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />}
        {!compact && (
          <XAxis dataKey="date" tickFormatter={formatDate} minTickGap={32} {...axisProps} />
        )}
        {!compact && <YAxis allowDecimals={false} width={48} {...axisProps} />}

        <Tooltip
          {...tooltipProps}
          labelFormatter={(value) => formatDate(String(value))}
          formatter={(value, name) => [value === null ? '—' : value, String(name)]}
        />
        {hasComparison && <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />}

        {/* Drawn first so the filled series sits in front of it: the comparison is a reference, not
            a rival. Dashed and in the muted text colour rather than a second categorical hue. */}
        {hasComparison && (
          <Line
            type="monotone"
            dataKey="previous"
            name={previousLabel ?? ''}
            stroke={AXIS}
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        )}

        <Area
          type="monotone"
          dataKey="current"
          name={label}
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#hedge-traffic-fill)"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function Ranked({ rows, valueLabel }: RankedProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
        barCategoryGap={6}
      >
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} {...axisProps} />
        {/* The label is the identity here, which is why one hue is enough for the bars. */}
        <YAxis type="category" dataKey="label" width={140} interval={0} {...axisProps} />
        <Tooltip {...tooltipProps} cursor={{ fill: 'var(--muted)', opacity: 0.4 }} />
        <Bar
          dataKey="value"
          name={valueLabel}
          fill="var(--chart-1)"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

function Audience({ points, gainedLabel, lostLabel, formatDate }: AudienceProps) {
  // Losses are negated so they fall below the baseline. The sign is then in the geometry, and the
  // two colours are only agreeing with something the reader can already see.
  const data = points.map((point) => ({
    date: point.date,
    gained: point.gained,
    lost: -point.lost,
  }))

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} stackOffset="sign">
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={formatDate} minTickGap={32} {...axisProps} />
        <YAxis
          allowDecimals={false}
          width={48}
          tickFormatter={(v) => String(Math.abs(Number(v)))}
          {...axisProps}
        />
        <ReferenceLine y={0} stroke={AXIS} />
        <Tooltip
          {...tooltipProps}
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          labelFormatter={(value) => formatDate(String(value))}
          formatter={(value, name) => [Math.abs(Number(value)), String(name)]}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          dataKey="gained"
          name={gainedLabel}
          fill="var(--chart-2)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="lost"
          name={lostLabel}
          fill="var(--chart-3)"
          radius={[0, 0, 4, 4]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
