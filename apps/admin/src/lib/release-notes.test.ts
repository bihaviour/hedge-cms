import { describe, expect, test } from 'bun:test'
import { type Block, type Inline, parseReleaseNotes } from './release-notes'

/**
 * The changelog renderer reads a release body written upstream, so these pin two different things:
 * that GitHub's own auto-generated notes come out as the structure they look like, and that a body
 * cannot smuggle anything executable into the admin through a link.
 */

/** The inline tokens of a heading or paragraph — the cases below say which they expect. */
function inline(blocks: Block[], index = 0): Inline[] {
  const block = blocks[index]
  if (!block || block.kind === 'list') throw new Error(`block ${index} is not a text block`)
  return block.content
}

/** Every token's text, bold included — it carries tokens of its own rather than a string. */
const flat = (tokens: Inline[]): string =>
  tokens.map((token) => (token.kind === 'strong' ? flat(token.content) : token.text)).join('')

/** The items of a list block, flattened to their text. */
function items(blocks: Block[], index = 0): string[] {
  const block = blocks[index]
  if (block?.kind !== 'list') throw new Error(`block ${index} is not a list`)
  return block.items.map(flat)
}

describe('parsing release notes', () => {
  test('reads the shape GitHub generates: a heading, then a list of changes', () => {
    const blocks = parseReleaseNotes(
      "## What's Changed\n* Upload several media files at once by @someone in https://github.com/bihaviour/hedge-cms/pull/103\n* Fix the beacon by @other in https://github.com/bihaviour/hedge-cms/pull/105\n",
    )

    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'list'])
    expect(flat(inline(blocks))).toBe("What's Changed")
    expect(items(blocks, 1)).toHaveLength(2)
  })

  test('turns a bare URL into a link, leaving the sentence punctuation behind', () => {
    expect(inline(parseReleaseNotes('See https://example.com/notes.'))).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/notes', href: 'https://example.com/notes' },
      { kind: 'text', text: '.' },
    ])
  })

  test('keeps a markdown link, and never builds one out of a script URL', () => {
    expect(inline(parseReleaseNotes('[the notes](https://example.com/x)'))).toEqual([
      { kind: 'link', text: 'the notes', href: 'https://example.com/x' },
    ])

    // A release body is written by somebody else. An `<a href="javascript:…">` rendered into the
    // admin would be their code running in an authenticated session, so it degrades to text.
    expect(inline(parseReleaseNotes('[click me](javascript:alert(1))'))).toEqual([
      { kind: 'text', text: '[click me](javascript:alert(1))' },
    ])
  })

  test('reads inline code and bold, and a URL inside backticks stays code', () => {
    const tokens = inline(parseReleaseNotes('Set **PUBLIC_URL** to `https://cms.example.com`'))
    expect(tokens.map((token) => token.kind)).toEqual(['text', 'strong', 'text', 'code'])
  })

  test('reads formatting inside bold — how these notes lead a paragraph', () => {
    // `**\`POST /api/v1/collect\` stays \`same-origin\`.**` is the house style upstream; flattening
    // bold to a string would print the backticks at an operator.
    const [bold] = inline(parseReleaseNotes('**`POST /api/v1/collect` stays put.** And then some.'))
    expect(bold).toEqual({
      kind: 'strong',
      content: [
        { kind: 'code', text: 'POST /api/v1/collect' },
        { kind: 'text', text: ' stays put.' },
      ],
    })
  })

  test('groups consecutive items into one list and starts a new block after a gap', () => {
    const blocks = parseReleaseNotes('- one\n- two\n\nA paragraph.\n\n1. three\n2. four')

    expect(blocks.map((block) => block.kind)).toEqual(['list', 'paragraph', 'list'])
    expect(items(blocks, 0)).toEqual(['one', 'two'])
    expect(items(blocks, 2)).toEqual(['three', 'four'])
  })

  test('folds a wrapped line into the item or paragraph it continues', () => {
    expect(items(parseReleaseNotes('- an item that\n  wrapped'))).toEqual(['an item that wrapped'])
    expect(flat(inline(parseReleaseNotes('a sentence that\nwrapped')))).toBe(
      'a sentence that wrapped',
    )
  })

  test('a wrapped list line keeps its own formatting', () => {
    // Release notes wrap at a column, not at a phrase, so the second line of an item carries code
    // spans and links as often as the first — appending it as raw text would show the backticks.
    const [list] = parseReleaseNotes('- served as\n  `application/json`, which preflights')
    const kinds = list?.kind === 'list' ? list.items[0]?.map((token) => token.kind) : []
    expect(kinds).toEqual(['text', 'code', 'text'])
  })

  test('an empty body is no blocks at all, not an empty paragraph', () => {
    expect(parseReleaseNotes('')).toEqual([])
    expect(parseReleaseNotes('\n  \n---\n')).toEqual([])
  })
})
