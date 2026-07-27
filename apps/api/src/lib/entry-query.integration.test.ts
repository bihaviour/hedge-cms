import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { type Field, fieldsSchema } from '@hedge/core'
import { and, eq, getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { entries } from '../db/schema'
import {
  type Cursor,
  cursorCondition,
  decodeCursor,
  encodeCursor,
  orderByClause,
  parseEntryFilters,
  resolveSort,
  whereConditions,
} from './entry-query'

// Unlike the pure-function unit tests, this runs the SQL the helpers build against a real SQLite,
// so it catches what only the database can tell us: that `_sort` aliases, that `json_extract`
// orders as expected, and that keyset pagination with an `id` tie-break neither drops nor repeats
// rows across a page boundary when the sort key is not unique.

const COLUMNS = { updatedAt: entries.updatedAt, slug: entries.slug }

const fields = fieldsSchema.parse([
  { kind: 'date', name: 'date', label: 'Date' },
  {
    kind: 'select',
    name: 'tags',
    label: 'Tags',
    options: [{ value: 'essay', label: 'Essay' }],
    multiple: true,
    creatable: true,
  },
]) as Field[]

function seed() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    create table entries (
      id text primary key,
      collection_id text not null,
      slug text not null,
      status text not null,
      visibility text not null,
      locale text not null,
      data text not null,
      metadata text,
      published_at text,
      created_by text,
      updated_by text,
      created_at text not null,
      updated_at text not null
    )
  `)
  const db = drizzle(sqlite, { casing: 'snake_case' })
  const base = {
    collectionId: 'c1',
    status: 'published' as const,
    visibility: 'public' as const,
    locale: 'en',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  db.insert(entries)
    .values([
      { ...base, id: 'ent_1', slug: 'about', data: { date: '1990-01-01', tags: ['about'] } },
      { ...base, id: 'ent_2', slug: 'post-a', data: { date: '2024-05-01', tags: ['essay', 'ai'] } },
      { ...base, id: 'ent_3', slug: 'post-b', data: { date: '2024-05-01', tags: ['essay'] } },
      { ...base, id: 'ent_4', slug: 'post-c', data: { date: '2024-06-01', tags: ['news'] } },
    ])
    .run()
  return db
}

/** Run one page of the list the way the routes do, returning the rows and the next cursor. */
function page(
  db: ReturnType<typeof seed>,
  sortParam: string,
  order: 'asc' | 'desc',
  limit: number,
  cursor: Cursor | null,
  params = new URLSearchParams(),
) {
  const sort = resolveSort(sortParam, fields, COLUMNS)
  const where = [
    eq(entries.collectionId, 'c1'),
    ...whereConditions(parseEntryFilters(params, fields)),
  ]
  if (cursor) where.push(cursorCondition(sort, order, cursor))
  const rows = db
    .select({ ...getTableColumns(entries), _sort: sort.expr })
    .from(entries)
    .where(and(...where))
    .orderBy(...orderByClause(sort, order))
    .limit(limit + 1)
    .all()
  const hasMore = rows.length > limit
  const slice = hasMore ? rows.slice(0, limit) : rows
  const last = slice.at(-1)
  return {
    ids: slice.map((r) => r.id),
    nextCursor: hasMore && last ? decodeCursor(encodeCursor(last._sort, last.id)) : null,
  }
}

describe('sorting by a declared field', () => {
  test('orders by json_extract, not publish order — the 1990 page pins to the bottom ascending', () => {
    const { ids } = page(seed(), 'data.date', 'asc', 50, null)
    expect(ids).toEqual(['ent_1', 'ent_2', 'ent_3', 'ent_4'])
  })

  test('keyset pages do not drop or repeat rows that share a sort value', () => {
    const db = seed()
    const first = page(db, 'data.date', 'asc', 2, null)
    expect(first.ids).toEqual(['ent_1', 'ent_2'])
    // ent_2 and ent_3 share the 2024-05-01 date; the id tie-break must land ent_3 on the next page.
    const second = page(db, 'data.date', 'asc', 2, first.nextCursor)
    expect(second.ids).toEqual(['ent_3', 'ent_4'])
    expect(second.nextCursor).toBeNull()
  })
})

describe('filtering by a declared field', () => {
  test('contains matches membership of an array field', () => {
    const { ids } = page(
      seed(),
      'data.date',
      'asc',
      50,
      null,
      new URLSearchParams('where[tags][contains]=essay'),
    )
    expect(ids).toEqual(['ent_2', 'ent_3'])
  })

  test('gte compares against the extracted value', () => {
    const { ids } = page(
      seed(),
      'data.date',
      'asc',
      50,
      null,
      new URLSearchParams('where[date][gte]=2024-06-01'),
    )
    expect(ids).toEqual(['ent_4'])
  })
})
