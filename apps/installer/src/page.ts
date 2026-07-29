import { HEDGE_REPO } from '@hedge/core'

/**
 * The installer page: one document, one inline script, no network fetches of its own.
 *
 * Self-contained on purpose. The runner has no asset pipeline and nothing to cache, and a page that
 * pulled a font or a stylesheet from a CDN would be making a request the operator did not ask for
 * from a tool whose entire pitch is that it talks to nobody but Cloudflare.
 */

const TOKEN_TEMPLATE_URL = 'https://dash.cloudflare.com/profile/api-tokens'

export function renderPage(clientScript: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Install Hedge</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <header>
    <h1>Install Hedge</h1>
    <p class="lede">
      Creates a database, a bucket and a Worker on your own Cloudflare account, and deploys the
      latest release to them. No Git account, and nothing to install afterwards.
    </p>
    <p class="privacy">
      This page is served by a program running on your machine. Your Cloudflare API token is sent to
      that program and to Cloudflare, and nowhere else.
    </p>
  </header>

  <section id="step-token" class="step">
    <h2>1. Connect your Cloudflare account</h2>
    <p>
      Create an API token with the <strong>Edit Cloudflare Workers</strong> template, then add
      <strong>D1:Edit</strong> and <strong>Workers R2 Storage:Edit</strong> to it.
      <a href="${TOKEN_TEMPLATE_URL}" target="_blank" rel="noreferrer">Create a token →</a>
    </p>
    <label for="token">API token</label>
    <input id="token" type="password" autocomplete="off" spellcheck="false"
           placeholder="Paste your Cloudflare API token" />
    <button id="connect" type="button">Connect</button>
    <p class="error" id="token-error" hidden></p>
  </section>

  <section id="step-details" class="step" hidden>
    <h2>2. Name your deployment</h2>

    <label for="account">Cloudflare account</label>
    <select id="account"></select>

    <label for="name">Deployment name</label>
    <input id="name" value="hedge-cms" spellcheck="false" autocomplete="off" />
    <p class="hint">
      Lowercase letters, numbers and hyphens. This becomes your Worker's name, your URL
      (<code id="url-preview">hedge-cms</code>.&lt;your-subdomain&gt;.workers.dev), and the names of
      the database (<code id="db-preview">hedge-cms-db</code>) and bucket
      (<code id="bucket-preview">hedge-cms-media</code>) it creates.
    </p>

    <label for="app-name">What this CMS calls itself</label>
    <input id="app-name" value="Hedge" autocomplete="off" />
    <p class="hint">Shown in the admin and in every email it sends. Change it any time.</p>

    <details>
      <summary>Email settings (optional)</summary>
      <p class="hint">
        Hedge sends invites, password resets and newsletters through Cloudflare Email Sending, which
        needs a domain of yours onboarded first — a step that can only be done from a terminal:
        <code>wrangler email sending enable yourdomain.com</code>. <strong>Email will not work until
        you do that</strong>, whatever you put here. You can set both of these later in the admin
        under Settings → Email, and everything else about Hedge works without them.
      </p>
      <label for="email-from">Sender address</label>
      <input id="email-from" placeholder="hedge@yourdomain.com" autocomplete="off" />
      <label for="email-from-name">Sender name</label>
      <input id="email-from-name" placeholder="Acme Editorial" autocomplete="off" />
    </details>

    <div class="tradeoff">
      <h3>What you give up by installing this way</h3>
      <p>
        This creates no Git repository, so there is <strong>no CI, no preview URLs and no automatic
        redeploy on a push</strong> — there is nothing to push to. You update from inside the admin,
        under Settings → About &amp; updates, by pasting a token the same way you just did. If you
        would rather have a repository to work in, stop here and use the Deploy to Cloudflare button
        on <a href="https://github.com/${HEDGE_REPO}" target="_blank" rel="noreferrer">the
        README</a> instead.
      </p>
    </div>

    <button id="install" type="button">Install Hedge <span id="version"></span></button>
    <p class="error" id="install-error" hidden></p>
  </section>

  <section id="step-progress" class="step" hidden>
    <h2>3. Installing</h2>
    <ul id="steps"></ul>
    <div id="result" hidden></div>
  </section>
</main>
<script type="module">${clientScript}</script>
</body>
</html>
`
}

const STYLES = `
:root { color-scheme: light dark; --line: color-mix(in oklab, currentColor 15%, transparent); }
* { box-sizing: border-box; }
body {
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; padding: 3rem 1.25rem 6rem;
}
main { max-width: 40rem; margin: 0 auto; }
h1 { font-size: 1.9rem; margin: 0 0 .5rem; letter-spacing: -0.02em; }
h2 { font-size: 1.15rem; margin: 0 0 1rem; letter-spacing: -0.01em; }
h3 { font-size: .95rem; margin: 0 0 .4rem; }
.lede { margin: 0 0 1rem; opacity: .8; }
.privacy {
  margin: 0 0 2.5rem; padding: .75rem 1rem; font-size: .875rem;
  border: 1px solid var(--line); border-radius: .5rem; opacity: .85;
}
.step { border-top: 1px solid var(--line); padding-top: 2rem; margin-top: 2rem; }
.step:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
label { display: block; font-weight: 600; font-size: .875rem; margin: 1.25rem 0 .35rem; }
input, select {
  width: 100%; padding: .6rem .75rem; font: inherit; border-radius: .5rem;
  border: 1px solid var(--line); background: transparent; color: inherit;
}
button {
  margin-top: 1.5rem; padding: .7rem 1.4rem; font: inherit; font-weight: 600; cursor: pointer;
  border-radius: .5rem; border: 1px solid var(--line); background: currentColor;
}
button span { color: inherit; }
button:disabled { opacity: .5; cursor: default; }
.hint { font-size: .8125rem; opacity: .7; margin: .4rem 0 0; }
.error {
  margin-top: 1rem; padding: .75rem 1rem; font-size: .875rem; border-radius: .5rem;
  border: 1px solid #d33; color: #d33;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; }
details { margin-top: 1.5rem; }
summary { cursor: pointer; font-weight: 600; font-size: .875rem; }
.tradeoff {
  margin-top: 2rem; padding: 1rem; border: 1px solid var(--line); border-radius: .5rem;
  font-size: .875rem;
}
.tradeoff p { margin: 0; opacity: .85; }
#steps { list-style: none; padding: 0; margin: 0; }
#steps li { display: flex; gap: .75rem; padding: .5rem 0; align-items: baseline; }
#steps .marker { width: 1.25rem; flex: none; text-align: center; }
#steps .detail { font-size: .8125rem; opacity: .65; }
#steps li[data-status="pending"] { opacity: .45; }
#steps li[data-status="failed"] .marker { color: #d33; }
#result { margin-top: 2rem; padding: 1.25rem; border: 1px solid var(--line); border-radius: .5rem; }
#result h3 { font-size: 1.05rem; }
#result a { font-weight: 600; }
#result pre { white-space: pre-wrap; font-size: .8125rem; margin: .75rem 0 0; opacity: .85; }
`
