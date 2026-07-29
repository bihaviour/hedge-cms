import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The three ways a migration applies cleanly to the local D1 and then fails a deploy.
 *
 * `db:migrate:remote` posts a migration file to D1's HTTP API **verbatim**, and that parser splits
 * on `;` *before* stripping comments. `.claude/rules/database.md` names the three shapes that break
 * it, all of which wrangler's local splitter accepts, so nothing in the normal loop catches them —
 * the rule file's own advice is to provision a throwaway D1 and try.
 *
 * The in-Worker runner (`migrate.ts`) is immune to all three, and after #38 so is the installer, but
 * `db:migrate:remote` still exists and a migration still has to satisfy it. That is exactly the kind
 * of constraint that gets forgotten, so it is checked here rather than remembered: these are static
 * properties of the text, and a test costs nothing next to a failed production deploy reporting only
 * "SQL code did not contain a statement [code: 7500]".
 *
 * This does not replace a remote probe — it cannot see a statement D1 rejects on its own merits. It
 * covers the three failure modes that are *invisible* locally, which is where the trap is.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', '..', 'apps', 'api', 'migrations')
const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'))

/** Comment spans, as the *local* reading of the file sees them — which is the reading that lies. */
interface Comment {
  kind: 'line' | 'block'
  text: string
  line: number
}

function comments(sql: string): Comment[] {
  const found: Comment[] = []
  let index = 0
  let line = 1

  while (index < sql.length) {
    const char = sql[index]

    if (char === '\n') {
      line++
      index++
      continue
    }

    // A string literal can hold anything, including `--`; skip it whole.
    if (char === "'") {
      index++
      while (index < sql.length && sql[index] !== "'") {
        if (sql[index] === '\n') line++
        index++
      }
      index++
      continue
    }

    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index)
      const stop = end === -1 ? sql.length : end
      found.push({ kind: 'line', text: sql.slice(index, stop), line })
      index = stop
      continue
    }

    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      const stop = end === -1 ? sql.length : end + 2
      const text = sql.slice(index, stop)
      found.push({ kind: 'block', text, line })
      line += (text.match(/\n/g) ?? []).length
      index = stop
      continue
    }

    index++
  }

  return found
}

/**
 * The detectors have to be able to fail, or the suite below is 40 green ticks that mean nothing.
 * Each case here is a migration that applies cleanly to the local D1 and then breaks a deploy.
 */
describe('the comment scanner sees what the remote parser sees', () => {
  test('finds a semicolon inside a line comment', () => {
    const found = comments('-- drop it; then recreate\nCREATE TABLE a (id text);')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toContain(';')
  })

  test('finds a semicolon inside a block comment', () => {
    const found = comments('/* was: DROP TABLE a; */\nCREATE TABLE a (id text);')
    expect(found.filter((comment) => comment.text.includes(';'))).toHaveLength(1)
  })

  test('finds the double hyphen in a block-comment ruler', () => {
    const found = comments('/* ----- section ----- */\nCREATE TABLE a (id text);')
    expect(found[0]?.kind).toBe('block')
    expect(found[0]?.text.slice(2, -2)).toContain('--')
  })

  test("ignores a hyphen pair inside a string literal, which isn't a comment", () => {
    expect(comments("INSERT INTO a VALUES ('-- not a comment; really');")).toEqual([])
  })

  test('reports the line a comment starts on', () => {
    const found = comments('CREATE TABLE a (id text);\n\n-- oops;\n')
    expect(found[0]?.line).toBe(3)
  })
})

describe("committed migrations satisfy D1's remote HTTP parser", () => {
  test('there are migrations to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(9)
  })

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')

    describe(file, () => {
      /**
       * The API splits on `;` before stripping comments, so the fragment ahead of a semicolon
       * *inside* a comment arrives as a "statement" that is only a comment — code 7500.
       */
      test('no semicolon inside a comment', () => {
        const offenders = comments(sql).filter((comment) => comment.text.includes(';'))
        expect(
          offenders.map((comment) => `line ${comment.line}: ${comment.text.slice(0, 60)}`),
        ).toEqual([])
      })

      /**
       * `--` inside a block comment reads as opening a line comment, which swallows the closing
       * `*​/`, so the block never ends and eats the rest of the file. A `/* ----- *​/` ruler is the
       * usual way in; `===` is the convention here instead.
       */
      test('no double-hyphen inside a block comment', () => {
        const offenders = comments(sql)
          .filter((comment) => comment.kind === 'block')
          .filter((comment) => comment.text.slice(2, -2).includes('--'))
        expect(offenders.map((comment) => `line ${comment.line}`)).toEqual([])
      })

      /** A trailing chunk that is only a comment is a chunk with no statement in it. */
      test('the file ends on a statement, not a comment', () => {
        const trimmed = sql.trimEnd()
        const lastSemicolon = trimmed.lastIndexOf(';')
        const tail = trimmed.slice(lastSemicolon + 1).trim()
        expect(tail).toBe('')
      })

      /**
       * Not a remote failure but a local one, and it corrupts a file just as completely: wrangler's
       * local splitter treats `CASE` and `BEGIN` as opening a compound statement that closes only on
       * `END`, so `… ELSE 0 END,` swallows every later semicolon. Prefer `IIF()` or a bare
       * comparison.
       */
      test("no CASE expression, which wrangler's local splitter mis-nests", () => {
        const withoutComments = comments(sql).reduce(
          (text, comment) => text.replace(comment.text, ''),
          sql,
        )
        expect(/\bCASE\b/i.test(withoutComments)).toBe(false)
      })
    })
  }
})
