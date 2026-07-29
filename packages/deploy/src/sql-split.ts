/**
 * A comment-aware SQL statement splitter — the thing `.claude/rules/database.md` is a list of
 * warnings about.
 *
 * `db:migrate:remote` posts a whole migration file to D1's HTTP API and lets *its* parser split the
 * statements, and that parser splits on `;` before it understands comments or `CASE … END`. So a
 * semicolon inside a comment, a `--` inside a block comment, or a `CASE … END` compound each apply
 * cleanly to the local D1 and then fail a deploy with "SQL code did not contain a statement". The
 * in-Worker migration runner (#34) sidesteps all of that by owning the split: it submits one
 * statement at a time, so D1 never has to split anything.
 *
 * This tracks the four things a naive `split(';')` gets wrong:
 * - `--` line comments and `/* *​/` block comments (a `;` or a `--` inside one is not a delimiter)
 * - `'…'` string literals, `"…"` and `` `…` `` quoted identifiers (with doubled-quote escaping)
 * - `CASE` / `BEGIN … END` compounds, whose inner `;`s do not end the statement
 *
 * Comments are dropped from the emitted statements, so a fragment that is only a comment (drizzle's
 * `--> statement-breakpoint` markers, a trailing banner) disappears rather than being submitted as
 * an empty statement.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let buffer = ''
  // Depth of open CASE / BEGIN compounds. Inner `;`s only delimit at depth 0.
  let compoundDepth = 0
  let i = 0
  const n = sql.length

  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed) statements.push(trimmed)
    buffer = ''
  }

  while (i < n) {
    const c = sql[i]!
    const next = sql[i + 1]

    // Line comment: skip to the newline, which is left in place as whitespace.
    if (c === '-' && next === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      continue
    }

    // Block comment: skip to the closing marker, leaving a space so tokens don't fuse.
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      buffer += ' '
      continue
    }

    // Quoted string or identifier. Doubled quotes are an escaped quote, not a close.
    if (c === "'" || c === '"' || c === '`') {
      buffer += c
      i++
      while (i < n) {
        const d = sql[i]!
        if (d === c) {
          if (sql[i + 1] === c) {
            buffer += c + c
            i += 2
            continue
          }
          buffer += c
          i++
          break
        }
        buffer += d
        i++
      }
      continue
    }

    // A bare word: it might open (BEGIN/CASE) or close (END) a compound.
    if (isWordChar(c) && !isWordChar(sql[i - 1] ?? '')) {
      let j = i
      while (j < n && isWordChar(sql[j]!)) j++
      const word = sql.slice(i, j)
      const upper = word.toUpperCase()
      if (upper === 'BEGIN' || upper === 'CASE') compoundDepth++
      else if (upper === 'END' && compoundDepth > 0) compoundDepth--
      buffer += word
      i = j
      continue
    }

    if (c === ';' && compoundDepth === 0) {
      flush()
      i++
      continue
    }

    buffer += c
    i++
  }

  flush()
  return statements
}

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c)
}
