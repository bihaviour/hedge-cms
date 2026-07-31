# Website analytics

Hedge can show you what readers actually did — which articles were read, where they arrived from,
whether a newsletter landed — on the dashboard at `/` and in detail at `/analytics`.

This page is the website side: what to embed, what the numbers mean, and what they deliberately do
not claim. Everything here is optional. A site that runs its own analytics never embeds the snippet,
and the CMS then shows content and newsletter metrics only.

## Why the website has to tell us

**The Worker does not see your traffic, and cannot be made to.** This is worth understanding before
you read a single number, because the obvious shortcut is wrong.

Your website is a separate frontend on its own origin. A reader's browser never touches this
deployment. Your site calls the delivery API *server-side*, and those responses carry
`s-maxage=300, stale-while-revalidate=86400` — Cloudflare's edge absorbs the traffic and the origin
Worker only runs on a miss. With static generation one delivery call can serve a month of readers;
with a static build, zero calls serve everyone.

So delivery API request counts are **not** pageviews, and the factor between the two is unknowable
and different for every deployment. Nothing in Hedge presents them as traffic. Instead your pages
report a pageview directly, with the snippet below.

## The snippet

Add it once, in your site's template:

```html
<script src="https://your-cms.example.com/api/v1/collect/script.js" data-site="blog" defer></script>
```

`data-site` is the site's slug — the same value you would send in `X-Hedge-Site`. You can leave it
off if the deployment has only one site, or if that site's **Domain** is set to the hostname the
script runs on.

The admin shows this snippet, filled in for the current site, on the dashboard and on `/analytics`
whenever a site has no data yet.

### What it does

A few hundred bytes, no dependencies. On load it sends one beacon with the page's path and the
referrer, via `navigator.sendBeacon`. That is all.

- **It sets no cookie and reads no storage.** There is nothing here to put behind a consent banner.
- **It honours Do Not Track and Global Privacy Control** by not sending. The endpoint checks the
  headers as well, so a patched copy of the script gains nothing.
- **It never fails your page.** The endpoint answers `204` to everything — a good beacon, a bad one,
  an unknown site, a throttled flood — and nothing reads the response.
- **No raw IP is ever written.** Addresses are used for rate limiting and then discarded.
- **Unique visitors are not counted.** Doing so needs per-visitor state, even hashed; Hedge counts
  views, share clicks and referrers instead, and stores nothing per reader.

## Counting shares

**No platform reports share counts any more.** X removed its count endpoint, Facebook's needs an app
token, and LinkedIn withdrew theirs. What is honestly measurable is somebody clicking *your own*
share control, and that is only visible in your own click handler.

The script exposes one function for it:

```js
hedge('share', 'x')          // your X / Twitter button
hedge('share', 'linkedin')
hedge('share', 'copy')       // copy-link counts too
```

Call it from your share buttons. The admin labels the result "share clicks" and says plainly, next
to the number, that it is intent to share and not a platform count. Keep it that way in anything you
build on top: a figure labelled "shares" gets quoted in a meeting.

## Reading the numbers

| On the dashboard | What it is |
| --- | --- |
| **Views** | Pageviews reported by the snippet |
| **Pages read** | How many distinct paths were viewed at least once |
| **From other sites** | Views that arrived with a referrer from a host that is not yours |
| **Share clicks** | Clicks on your own share and copy-link controls |

Every figure is shown against the same figure for the period immediately before it. A number with no
comparison cannot be acted on.

Two things worth knowing about the detail page:

- **A large "direct" share is mostly missing referrer headers**, not readers typing your URL.
  Browsers withhold the referrer in plenty of ordinary situations.
- **Days are cut in the site's timezone** (Site settings → Localization), not in UTC. An evening in
  Jakarta belongs to the Jakarta day, which is the only reading that matches what you published.

If your range reaches back before you embedded the snippet, the page says so. The empty left-hand
side of the chart is an absence of measurement, not an absence of readers.

## Newsletter numbers need nothing embedded

Sends, failures, subscriber growth and unsubscribes come from rows the CMS already writes, so they
appear whether or not the snippet exists.

Two deliberate limits, stated in the admin where they are read:

- **"Accepted" is not "delivered".** Cloudflare Email Sending reports that it took a message; there
  is no bounce or delivery callback to reconcile against, so nothing claims a message reached an
  inbox.
- **Opens are not tracked.** Apple Mail Privacy Protection prefetches images, so an open rate counts
  Apple's proxy rather than readers, inflated by an amount that varies with audience and cannot be
  corrected. Clicks are the honest engagement number and are not implemented yet; when they are,
  they will be per-site opt-in and off by default.

## Retention and storage

Counts are aggregated as they arrive — one row per site, day, page and metric — so a million hits on
one article on one day is one row, not a million. Distinct paths, referrer hosts and share targets
are capped per site per day, and anything past the cap is counted under `(other)`: real traffic is
never dropped, just stopped from itemising without limit.

Rollups older than **400 days** are deleted by a daily cron. 400 rather than 365 so a
year-over-year comparison still has the far end of its range.

## Privacy summary

Should you need to write this down somewhere:

> The site uses first-party analytics provided by its CMS. It records the page visited, the
> referring site's hostname, and clicks on the site's own share buttons. It sets no cookies, stores
> no identifiers, does not track visitors between pages or across days, and honours Do Not Track and
> Global Privacy Control. Data is stored by the site operator, is not shared with any third party,
> and is deleted after 400 days.

Check it against your own deployment before publishing it — it describes Hedge's collector, not
anything else your site may run.
