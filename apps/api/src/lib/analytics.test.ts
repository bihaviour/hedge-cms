import { describe, expect, test } from 'bun:test'
import { ANALYTICS_MAX_PATHS_PER_DAY, ANALYTICS_OTHER, ANALYTICS_RETENTION_DAYS } from '@hedge/core'
import {
  addDays,
  capValue,
  dayInTimezone,
  daysBetween,
  eachDay,
  looksLikeBot,
  normalisePath,
  normaliseTarget,
  referrerHost,
  tracksRefused,
} from './analytics'

// These are the decisions the collector makes before it touches D1: which day a hit belongs to,
// what a path and a referrer reduce to, and whether a value is allowed to become its own row. Each
// of them is a rule rather than a query, so each is testable without a database.

describe('dayInTimezone', () => {
  // 2026-07-31 18:00 UTC is already the 1st in Jakarta (UTC+7) and still the 31st in New York.
  const evening = new Date('2026-07-31T18:00:00Z')

  test('cuts the day in the site timezone, not in UTC', () => {
    expect(dayInTimezone('UTC', evening)).toBe('2026-07-31')
    expect(dayInTimezone('Asia/Jakarta', evening)).toBe('2026-08-01')
    expect(dayInTimezone('America/New_York', evening)).toBe('2026-07-31')
  })

  test('always produces YYYY-MM-DD, zero-padded', () => {
    expect(dayInTimezone('UTC', new Date('2026-01-05T00:30:00Z'))).toBe('2026-01-05')
  })

  test('falls back to UTC for a timezone this runtime does not know', () => {
    expect(dayInTimezone('Mars/Olympus_Mons', evening)).toBe('2026-07-31')
  })
})

describe('day arithmetic', () => {
  test('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  test('daysBetween is inclusive, so one day is 1', () => {
    expect(daysBetween('2026-07-31', '2026-07-31')).toBe(1)
    expect(daysBetween('2026-07-01', '2026-07-31')).toBe(31)
  })

  test('eachDay fills every day in the range', () => {
    expect(eachDay('2026-07-30', '2026-08-01')).toEqual(['2026-07-30', '2026-07-31', '2026-08-01'])
  })

  test('the retention cutoff lands a sensible distance back', () => {
    const cutoff = addDays('2026-07-31', -ANALYTICS_RETENTION_DAYS)
    expect(daysBetween(cutoff, '2026-07-31')).toBe(ANALYTICS_RETENTION_DAYS + 1)
  })
})

describe('normalisePath', () => {
  test('drops the query string and the fragment', () => {
    expect(normalisePath('/blog/hello?utm_source=x#top')).toBe('/blog/hello')
  })

  test('accepts a full URL, keeping only the path', () => {
    expect(normalisePath('https://example.com/blog/hello')).toBe('/blog/hello')
  })

  test('folds the variants that would otherwise be separate rows', () => {
    expect(normalisePath('blog/hello')).toBe('/blog/hello')
    expect(normalisePath('/blog/hello/')).toBe('/blog/hello')
    expect(normalisePath('/blog//hello')).toBe('/blog/hello')
    expect(normalisePath('/')).toBe('/')
  })

  test('caps the length, so a long path cannot be a large row', () => {
    expect(normalisePath(`/${'a'.repeat(1000)}`).length).toBeLessThanOrEqual(256)
  })
})

describe('referrerHost', () => {
  test('reduces a referrer to its bare host', () => {
    expect(referrerHost('https://news.ycombinator.com/item?id=1', [])).toBe('news.ycombinator.com')
  })

  test('folds www. away so one site is one row', () => {
    expect(referrerHost('https://www.google.com/search?q=x', [])).toBe('google.com')
  })

  test('treats the site itself as internal, not as a referral', () => {
    expect(referrerHost('https://example.com/blog', ['example.com'])).toBeNull()
    expect(referrerHost('https://www.example.com/blog', ['example.com'])).toBeNull()
  })

  test('is null for nothing, and for something unparseable', () => {
    expect(referrerHost(undefined, [])).toBeNull()
    expect(referrerHost('', [])).toBeNull()
    expect(referrerHost('not a url', [])).toBeNull()
  })
})

describe('normaliseTarget', () => {
  test('reduces a share target to a small alphabet', () => {
    expect(normaliseTarget('X (Twitter)')).toBe('x-twitter')
    expect(normaliseTarget('copy')).toBe('copy')
  })

  test('names the absence rather than storing an empty dimension', () => {
    expect(normaliseTarget(undefined)).toBe('unknown')
    expect(normaliseTarget('   ')).toBe('unknown')
  })
})

describe('bot and tracking-preference filters', () => {
  test('drops the obvious crawlers, and anything with no user agent at all', () => {
    expect(looksLikeBot('Googlebot/2.1')).toBe(true)
    expect(looksLikeBot('curl/8.4.0')).toBe(true)
    expect(looksLikeBot(undefined)).toBe(true)
  })

  test('lets an ordinary browser through', () => {
    expect(
      looksLikeBot(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      ),
    ).toBe(false)
  })

  test('honours Do Not Track and Global Privacy Control', () => {
    expect(tracksRefused(new Headers({ dnt: '1' }))).toBe(true)
    expect(tracksRefused(new Headers({ 'sec-gpc': '1' }))).toBe(true)
    expect(tracksRefused(new Headers({ dnt: '0' }))).toBe(false)
    expect(tracksRefused(new Headers())).toBe(false)
  })
})

describe('capValue', () => {
  test('keeps a value while the day is under its cap', () => {
    expect(capValue(0, 3, '/a')).toBe('/a')
    expect(capValue(2, 3, '/a')).toBe('/a')
  })

  test('folds everything past the cap into one bucket', () => {
    expect(capValue(3, 3, '/a')).toBe(ANALYTICS_OTHER)
    expect(capValue(9_999, 3, '/a')).toBe(ANALYTICS_OTHER)
  })

  test('a flood of distinct paths cannot create more than cap + 1 rows for a day', () => {
    const rows = new Set<string>()
    for (let i = 0; i < 100_000; i++) {
      rows.add(capValue(rows.size, ANALYTICS_MAX_PATHS_PER_DAY, `/spam/${i}`))
    }
    expect(rows.size).toBe(ANALYTICS_MAX_PATHS_PER_DAY + 1)
    expect(rows.has(ANALYTICS_OTHER)).toBe(true)
  })
})
