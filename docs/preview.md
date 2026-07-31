# Authenticated preview

Seeing an unpublished entry the way a reader would see it — in your website's own layout, not in the
admin's form inputs.

Half of this feature runs in code Hedge does not own. Hedge is headless: it has no idea what a page
looks like, so the only component that can render a draft properly is your website. This page covers
the part you write.

## The flow

1. An editor opens an entry in the admin and presses **Preview**.
2. The CMS mints a short-lived token scoped to that one entry and builds a URL from the site's
   **preview URL** and the collection's **preview path**.
3. The browser opens that URL on *your* website, with the token in the `hedge_preview` query
   parameter.
4. Your website's **server** reads the token, calls the delivery API with it, and gets back the
   unpublished entry.
5. Your website renders it with the ordinary layout, and does not cache the result.

Configure steps 2 and 3 under **Settings → Configuration → Overview** (the site's preview URL, and
whether the admin may show previews in an embedded pane) and in each collection's field settings
(its preview path). A site with no preview URL simply has no Preview action — nothing breaks.

## The delivery API side

`GET /api/v1/content/:collection/:slug` accepts an extra header:

```
X-Hedge-Preview: <token>
```

With a valid token naming that exact collection, slug and locale, the endpoint serves the entry
whatever its status — draft, archived, or published — instead of filtering to published only. It
also unlocks a `members`-only entry, because the person previewing is a CMS user looking at their
own site's article.

Everything else is unchanged: the request still needs the site's delivery API key in
`Authorization`, and it still resolves the same tenant. A preview token is not a credential on its
own; it widens what your existing key may see, for one entry.

**List endpoints do not honour it.** Preview is a single-page act. A list that leaked drafts would be
exactly the site-wide exposure the per-entry scoping exists to prevent.

Preview responses always come back `cache-control: private, no-store`.

## Forward the token server-side

This is the part worth getting right, because the way it goes wrong is a credential leak.

**The delivery API key stays on your server.** The preview token arrives in the query string, which
is client-visible by nature; the key it is redeemed alongside is not. Fetch from your server —
a route handler, a server component, an endpoint — never from code the browser runs.

If the delivery key reaches client code it is in the page source, in the network tab, and in any
bundle you ship. It can then be lifted and used against your delivery API by anyone, from anywhere,
for as long as it exists. Rotating it means editing every deployment that holds it. Preview does not
require this and no amount of convenience is worth it.

### Next.js (App Router)

```ts
// app/preview/[collection]/[slug]/page.tsx
export const dynamic = 'force-dynamic' // never cache a preview render

export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ collection: string; slug: string }>
  searchParams: Promise<{ hedge_preview?: string; locale?: string }>
}) {
  const { collection, slug } = await params
  const { hedge_preview: token, locale = 'en' } = await searchParams
  if (!token) return <p>Missing preview token.</p>

  const response = await fetch(
    `${process.env.HEDGE_URL}/api/v1/content/${collection}/${slug}?locale=${locale}`,
    {
      headers: {
        // Server-side only — this key must never reach the browser.
        authorization: `Bearer ${process.env.HEDGE_API_KEY}`,
        'x-hedge-preview': token,
      },
      cache: 'no-store',
    },
  )

  if (!response.ok) return <p>This preview link has expired.</p>

  const { data } = await response.json()
  return <Article entry={data} />
}
```

Point the site's preview URL at `https://example.com/preview` and leave the collection's preview
path at its default, `/{collection}/{slug}`.

### Astro (SSR)

```astro
---
// src/pages/preview/[collection]/[slug].astro
export const prerender = false // this page is per-token, never build it

const { collection, slug } = Astro.params
const token = Astro.url.searchParams.get('hedge_preview')
const locale = Astro.url.searchParams.get('locale') ?? 'en'

let entry = null
if (token) {
  const response = await fetch(
    `${import.meta.env.HEDGE_URL}/api/v1/content/${collection}/${slug}?locale=${locale}`,
    {
      headers: {
        authorization: `Bearer ${import.meta.env.HEDGE_API_KEY}`,
        'x-hedge-preview': token,
      },
    },
  )
  if (response.ok) entry = (await response.json()).data
}

Astro.response.headers.set('cache-control', 'private, no-store')
---

{entry ? <Article entry={entry} /> : <p>This preview link has expired.</p>}
```

## Do not cache the preview render

Whatever your framework's opt-out is — `export const dynamic = 'force-dynamic'`,
`export const prerender = false`, `cache: 'no-store'`, a `Cache-Control: private, no-store` on the
response — use it on the preview route only.

The response is per-token and short-lived. A cached preview is a draft served to whoever asks next.

## The embedded pane, and the header it needs

By default Preview opens in a new tab, which always works. The admin can also show a preview in a
pane inside the CMS, which is nicer — and which your website has to allow, because framing is the
target's decision, not the parent's.

Turn it on per site with **Show previews in a pane inside the admin**, and let the CMS origin frame
your preview route:

```
Content-Security-Policy: frame-ancestors 'self' https://cms.example.com
```

Substitute your own CMS origin. If you also send `X-Frame-Options`, remove it for this route — it has
no origin allowlist, so `DENY` and `SAMEORIGIN` both block the pane.

Leaving your headers alone is a perfectly good answer. It simply means preview opens in a tab, and
the pane — which cannot detect a refused frame from the outside — carries a visible link out.

## What a preview token is, and is not

- **One entry.** One collection, one slug, one locale. A token for `posts/hello-world` in `en` does
  not open the entry next door, or the same article's Indonesian translation.
- **One site.** It names the site it was minted on and resolves on no other, even in a deployment
  where you administer both.
- **Minutes, not days.** Around half an hour by default, four hours at the very most. A token lands
  in browser history and can reach your site as a referrer; the short life is what makes that
  acceptable. It cannot be revoked before it expires — it is signed rather than stored, so nothing
  is looked up when it is redeemed.
- **Mintable only by a signed-in CMS user.** An API key that can write entries still cannot produce
  a preview link, and neither can an MCP client acting on someone's behalf. "Only authorised people
  can see unpublished content" is the whole requirement, so the key sitting in your website's
  environment variables is not allowed to manufacture one.
- **Not a credential on its own.** It unlocks an entry for a request that is already authenticated
  with a delivery API key. On its own it opens nothing.

Treat a preview link like a password for that one article: it is short-lived, but while it lives,
anyone holding it can read that draft.

## Previewing unsaved edits

You cannot, and that is deliberate. Preview shows what is **saved** — the editor's live form buffer
never leaves the browser. Save first, then preview.
