/**
 * A very small Markdown reader, for one input: the body of a GitHub release.
 *
 * It exists rather than a Markdown dependency because of what it is used for. Release notes reach
 * the admin from a third party, so the safe thing is to never build markup out of them at all — this
 * produces a token tree the renderer turns into React elements, and there is no path from a release
 * body to `dangerouslySetInnerHTML`. A general Markdown library would also land in the admin's main
 * chunk, which is served on every cold load, to format a page most operators open twice a year.
 *
 * It therefore covers the subset GitHub's own release notes are written in — headings, bullet and
 * numbered lists, `code`, `**bold**`, `[links](url)` and bare URLs — and degrades anything else to
 * the text it was written as. An unhandled construct shows as plain text, never as a broken render.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  /** Bold carries tokens rather than a string: `**`code`, bolded**` is how these notes are written. */
  | { kind: 'strong'; content: Inline[] }
  | { kind: 'link'; text: string; href: string }

export type Block =
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'list'; items: Inline[][] }

/** `# ` … `###### ` — the level is clamped by the renderer, which never emits an `<h1>`. */
const HEADING = /^(#{1,6})\s+(.*)$/
/** A bullet (`-`, `*`, `+`) or a number (`1.`, `1)`); both render as one list. */
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
/** `---`, `***`, `___` — a rule carries no words, so it only ends the block before it. */
const RULE = /^\s*([-*_])\1{2,}\s*$/

/**
 * Inline spans, in one pass so the first match wins: a URL inside a `[label](url)` is part of the
 * link, not a second bare one, and neither is text inside backticks.
 */
const INLINE = /`([^`]+)`|\*\*([^*]+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()[\]]+)/g

/** Trailing sentence punctuation belongs to the sentence, not to a bare URL that ends one. */
const URL_TAIL = /[.,;:!?]+$/

/**
 * `http(s)` only. The rendered link is an `<a href>`, so a `javascript:` or `data:` URL in a release
 * body would be a script somebody else wrote running in the admin. Anything else stays text.
 */
function safeHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null
}

function parseInline(line: string): Inline[] {
  const tokens: Inline[] = []
  let cursor = 0

  const pushText = (text: string) => {
    if (!text) return
    const last = tokens.at(-1)
    // Merge with the previous run rather than emitting neighbouring text nodes — a link that was
    // rejected as unsafe becomes text and should read as part of the sentence around it.
    if (last?.kind === 'text') last.text += text
    else tokens.push({ kind: 'text', text })
  }

  // A scanner of its own per call, not the shared `INLINE`: bold reparses its contents, and a
  // recursive call into a `g`-flagged regex would reset the `lastIndex` its own caller is scanning
  // with — an infinite loop, and a subtle one.
  const scanner = new RegExp(INLINE.source, 'g')
  let match = scanner.exec(line)
  while (match) {
    pushText(line.slice(cursor, match.index))
    const [raw, code, strong, linkText, linkHref, bareUrl] = match

    if (code !== undefined) tokens.push({ kind: 'code', text: code })
    // Bold reparses its own contents, because a bolded lead-in to a release note is usually a
    // sentence with a `path` or an `identifier` in it, and the backticks would otherwise show.
    else if (strong !== undefined) tokens.push({ kind: 'strong', content: parseInline(strong) })
    else if (linkText !== undefined && linkHref !== undefined) {
      const href = safeHref(linkHref)
      if (href) tokens.push({ kind: 'link', text: linkText, href })
      else pushText(raw)
    } else if (bareUrl !== undefined) {
      const trimmed = bareUrl.replace(URL_TAIL, '')
      const href = safeHref(trimmed)
      if (href) tokens.push({ kind: 'link', text: trimmed, href })
      else pushText(trimmed)
      // Whatever the trim took off is ordinary punctuation and stays in the sentence.
      pushText(bareUrl.slice(trimmed.length))
    }

    cursor = match.index + raw.length
    match = scanner.exec(line)
  }

  pushText(line.slice(cursor))
  return tokens
}

/**
 * Append one token run to another, joining text that meets text. Two adjacent text tokens render
 * the same as one, but keeping the run merged is what lets a test read a wrapped line as the
 * sentence it is rather than as the two halves it was written on.
 */
function appendInline(target: Inline[], tokens: Inline[]): void {
  for (const token of tokens) {
    const last = target.at(-1)
    if (token.kind === 'text' && last?.kind === 'text') last.text += token.text
    else target.push(token)
  }
}

/** Parse a release body into blocks. Returns `[]` for an empty or whitespace-only body. */
export function parseReleaseNotes(markdown: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: Inline[][] | null = null

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) })
      paragraph = []
    }
    if (list) {
      blocks.push({ kind: 'list', items: list })
      list = null
    }
  }

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()

    if (!line.trim() || RULE.test(line)) {
      flush()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        content: parseInline((heading[2] ?? '').trim()),
      })
      continue
    }

    const item = BULLET.exec(line) ?? NUMBERED.exec(line)
    if (item) {
      // A list interrupts a paragraph but continues an open list, so consecutive items stay one.
      if (paragraph.length) flush()
      list ??= []
      list.push(parseInline((item[1] ?? '').trim()))
      continue
    }

    // A line inside a list that is not an item is a wrapped continuation of the last one, and it is
    // parsed rather than appended raw: release notes wrap mid-sentence, so the `code` and links a
    // list item carries are as likely to land on the second line as the first.
    const continuation = list?.at(-1)
    if (continuation) {
      appendInline(continuation, parseInline(` ${line.trim()}`))
      continue
    }

    paragraph.push(line.trim())
  }

  flush()
  return blocks
}
