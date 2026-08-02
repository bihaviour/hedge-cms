import type { ReleaseNote } from '@hedge/core'
import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useFormatters } from '@/lib/i18n'
import { type Block, type Inline, parseReleaseNotes } from '@/lib/release-notes'

/**
 * A release and its notes, as the About page's changelog shows them.
 *
 * The body is parsed to tokens and rendered as React elements — never as markup — because it is
 * written upstream and arrives through GitHub's API. See `lib/release-notes.ts` for why that is the
 * whole security argument and not merely a convenience.
 */
export function ReleaseNotes({ release, isCurrent }: { release: ReleaseNote; isCurrent: boolean }) {
  const { formatDate } = useFormatters()
  const blocks = parseReleaseNotes(release.notes)
  // The title is usually the tag over again; showing it twice reads as a mistake.
  const title = release.name && release.name !== release.version ? release.name : null

  return (
    <article className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge variant={isCurrent ? 'secondary' : 'default'} className="font-mono">
          {release.version}
        </Badge>
        {title && <span className="font-medium text-sm">{title}</span>}
        {release.publishedAt && (
          <span className="text-muted-foreground text-xs">{formatDate(release.publishedAt)}</span>
        )}
        {isCurrent && <span className="text-muted-foreground text-xs">· running now</span>}
      </div>

      {blocks.length ? (
        <div className="space-y-2 text-sm">
          {blocks.map((block, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a parsed release body is fixed text — it has no id, and nothing inserts, removes or reorders a block
            <BlockView key={index} block={block} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">This release came with no notes.</p>
      )}

      {release.truncated && (
        <p className="text-muted-foreground text-xs">
          These notes were shortened.{' '}
          <a
            href={release.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            Read the rest on GitHub
          </a>
          .
        </p>
      )}

      <a
        href={release.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
      >
        {release.version} on GitHub <ExternalLink className="size-3" />
      </a>
    </article>
  )
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === 'heading') {
    // Never an `<h1>`: the page already has one, and a release body starting at `#` would otherwise
    // outrank the page title. Levels below that keep their relative order.
    const Tag = (block.level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4'
    return (
      <Tag className="font-medium text-foreground text-sm">
        <InlineView content={block.content} />
      </Tag>
    )
  }

  if (block.kind === 'list') {
    return (
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {block.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parsed from fixed text; the list never changes after it is read
          <li key={index}>
            <InlineView content={item} />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <p className="text-muted-foreground">
      <InlineView content={block.content} />
    </p>
  )
}

function InlineView({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((token, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed from fixed text; the token run never changes after it is read
        <TokenView key={index} token={token} />
      ))}
    </>
  )
}

function TokenView({ token }: { token: Inline }) {
  if (token.kind === 'code') {
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{token.text}</code>
  }
  if (token.kind === 'strong') {
    return (
      <strong className="font-medium text-foreground">
        <InlineView content={token.content} />
      </strong>
    )
  }
  if (token.kind === 'link') {
    // `href` is `http(s)` by construction — `lib/release-notes.ts` refuses every other scheme, which
    // is the check that keeps an upstream release body from becoming script in an admin session.
    return (
      <a
        href={token.href}
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline"
      >
        {token.text}
      </a>
    )
  }
  return <>{token.text}</>
}
