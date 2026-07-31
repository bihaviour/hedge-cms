import { describe, expect, mock, test } from 'bun:test'
import { ANALYTICS_RETENTION_DAYS } from '@hedge/core'
import type { Bindings } from '../env'

// `pruneAnalytics` is the only thing the Worker's `scheduled` handler does, and it is the only code
// path in the deployment nobody ever exercises by hand — so what it deletes is worth pinning.
//
// Note for anyone testing the cron locally: `wrangler dev --test-scheduled` exposes `/__scheduled`,
// but the assets binding answers that path first (`not_found_handling: single-page-application`,
// and `run_worker_first` covers only /api, /media and /.well-known), so the request returns
// index.html and the handler never runs. That is a dev-server routing artifact — a real cron event
// invokes `scheduled` directly and never touches the asset router.

/** The `where` clause the delete was issued with, captured as the value it compared against. */
let deletedBelow: unknown = null

// `mock.module` is process-wide and outlives this file, so the replacement keeps every export.
const realClient = await import('../db/client')

mock.module('../db/client', () => ({
  ...realClient,
  getDb: () => ({
    delete: () => ({
      where: (condition: { queryChunks?: { value?: unknown }[] }) => ({
        returning: async () => {
          // The cutoff is the one bound parameter in `lt(date, cutoff)`. The chunk graph is
          // cyclic, so it is walked one level rather than serialised.
          deletedBelow =
            condition?.queryChunks?.find(
              (chunk) =>
                typeof chunk?.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(chunk.value),
            )?.value ?? null
          return [{ id: 'anl_old' }]
        },
      }),
    }),
  }),
}))

const { pruneAnalytics, addDays, daysBetween } = await import('./analytics')

const env = { AUTH_SECRET: 'secret' } as unknown as Bindings

describe('pruneAnalytics', () => {
  test('deletes below a cutoff exactly the retention window back', async () => {
    const deleted = await pruneAnalytics(env)

    expect(deleted).toBe(1)
    expect(deletedBelow).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const today = new Date().toISOString().slice(0, 10)
    expect(deletedBelow).toBe(addDays(today, -ANALYTICS_RETENTION_DAYS))
  })

  test('the window is long enough for a year-over-year comparison to survive', async () => {
    // 400 rather than 365 on purpose: at exactly a year, "this time last year" is the first row to
    // disappear, which is the one comparison the retention is there to make possible.
    expect(ANALYTICS_RETENTION_DAYS).toBeGreaterThan(365)

    const today = new Date().toISOString().slice(0, 10)
    const aYearAgo = addDays(today, -365)
    const cutoff = addDays(today, -ANALYTICS_RETENTION_DAYS)
    expect(daysBetween(cutoff, aYearAgo)).toBeGreaterThan(0)
  })
})
