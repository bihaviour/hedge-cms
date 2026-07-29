import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitSqlStatements } from './sql-split'

/**
 * Comments and quoted text are non-semantic to the delimiter, so a comparable form drops both and
 * collapses whitespace — letting us compare our splitter's output against drizzle's own explicit
 * `--> statement-breakpoint` markers, which are the ground truth for where statements end.
 */
function normalize(statement: string): string {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
}

describe('splitSqlStatements — synthetic edge cases', () => {
  test('ignores a semicolon inside a string literal', () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      'SELECT 1',
    ])
  })

  test('ignores a semicolon inside a line comment', () => {
    expect(splitSqlStatements('SELECT 1; -- a; b\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  test('ignores a semicolon inside a block comment', () => {
    expect(splitSqlStatements('SELECT 1 /* a; b */; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  test('handles a double dash inside a block comment without swallowing the file', () => {
    const sql = 'SELECT 1 /* ----- section ----- */;\nSELECT 2'
    expect(splitSqlStatements(sql)).toEqual(['SELECT 1', 'SELECT 2'])
  })

  test('does not split inside a CASE … END compound', () => {
    const sql = 'UPDATE t SET x = CASE WHEN a THEN 1; ELSE 0 END WHERE y; SELECT 2'
    // The `;` after `1` is inside the compound and must not delimit.
    expect(splitSqlStatements(sql)).toEqual([
      'UPDATE t SET x = CASE WHEN a THEN 1; ELSE 0 END WHERE y',
      'SELECT 2',
    ])
  })

  test('does not split inside a trigger BEGIN … END body', () => {
    const sql =
      'CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE a SET b = 1; DELETE FROM c; END; SELECT 9'
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE a SET b = 1; DELETE FROM c; END',
      'SELECT 9',
    ])
  })

  test('treats doubled quotes as an escaped quote, not a close', () => {
    expect(splitSqlStatements("SELECT 'it''s; fine'; SELECT 2")).toEqual([
      "SELECT 'it''s; fine'",
      'SELECT 2',
    ])
  })

  test('drops comment-only fragments rather than emitting empty statements', () => {
    expect(
      splitSqlStatements('SELECT 1;\n--> statement-breakpoint\nSELECT 2;\n-- trailing'),
    ).toEqual(['SELECT 1', 'SELECT 2'])
  })
})

/**
 * The real proof: every committed migration must split the same way our splitter does and drizzle's
 * `--> statement-breakpoint` markers do. These files already exercise block comments, `IF EXISTS`,
 * multi-line inserts and the constrained-comment rules, so agreement here is broad coverage.
 */
describe('splitSqlStatements — committed migrations', () => {
  const dir = join(import.meta.dir, '..', '..', 'migrations')
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql'))

  test('there are migrations to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(9)
  })

  for (const file of files) {
    test(file, () => {
      const sql = readFileSync(join(dir, file), 'utf8')

      const mine = splitSqlStatements(sql).map(normalize)
      const oracle = sql
        .split('--> statement-breakpoint')
        .map(normalize)
        .filter((statement) => statement.length > 0)

      expect(mine).toEqual(oracle)
      // Every statement our splitter emits is itself a single statement.
      for (const statement of splitSqlStatements(sql)) {
        expect(splitSqlStatements(statement).length).toBe(1)
      }
    })
  }
})
