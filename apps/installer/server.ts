import { HEDGE_REPO } from '@hedge/core'
import {
  CloudflareError,
  cloudflareClient,
  fetchReleaseArtifact,
  latestRelease,
  listAccounts,
  verifyToken,
} from '@hedge/deploy'
import { nameAvailable, runInstall } from './src/install'
import { renderPage } from './src/page'
import type { AccountsResponse, InstallRequest, InstallResult } from './src/protocol'

/**
 * The Hedge installer's local runner (#38).
 *
 * **This process exists because of spike #37.** `api.cloudflare.com` serves no CORS headers, so no
 * browser page can call it — not one we host, and not one the operator opens from their own disk.
 * Rather than route every operator's Cloudflare API token through infrastructure we run, the
 * installer runs here: the page is served from `127.0.0.1`, the token is posted to this process, and
 * this process calls Cloudflare. The token stays on the machine it was typed on, and nothing about
 * the install touches anything of ours. See `docs/spikes/37-browser-cloudflare-api/`.
 *
 * It holds no state, writes no file, and binds to loopback only. Stop it and nothing of it remains.
 */

const PORT = Number(process.env.HEDGE_INSTALLER_PORT ?? 8976)

/**
 * The page's script, bundled from `src/client.ts` at start-up and inlined into the HTML.
 *
 * Bundling here rather than in a build step keeps the installer to a single command with no
 * artifact to build, stale or commit. It costs a few hundred milliseconds once, on a process whose
 * whole life is one install.
 */
async function bundleClient(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [new URL('./src/client.ts', import.meta.url).pathname],
    target: 'browser',
    minify: false,
  })
  if (!result.success) {
    throw new AggregateError(result.logs, 'could not bundle the installer page')
  }
  const [output] = result.outputs
  if (!output) throw new Error('the installer page bundled to nothing')
  return output.text()
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Cloudflare's own error text is the useful part; everything else becomes a plain message. */
function describe(error: unknown): string {
  if (error instanceof CloudflareError) return error.message
  return error instanceof Error ? error.message : String(error)
}

async function handleAccounts(request: Request): Promise<Response> {
  const { token } = (await request.json()) as { token?: string }
  if (!token?.trim()) return json({ error: 'Paste your Cloudflare API token to continue.' }, 400)

  const client = cloudflareClient('', token.trim())

  try {
    const verification = await verifyToken(client)
    if (verification.status !== 'active') {
      return json({ error: 'That Cloudflare API token is not active.' }, 400)
    }
  } catch (error) {
    if (error instanceof CloudflareError) {
      return json({ error: 'That token was rejected by Cloudflare — check it and try again.' }, 400)
    }
    throw error
  }

  let accounts: AccountsResponse['accounts']
  try {
    accounts = await listAccounts(client)
  } catch (error) {
    if (error instanceof CloudflareError && error.isAuthFailure) {
      return json(
        {
          error:
            'The token is valid but cannot list your accounts. Add the "Account Settings:Read" permission to it, or create the token from the "Edit Cloudflare Workers" template.',
        },
        400,
      )
    }
    throw error
  }
  if (accounts.length === 0) {
    return json({ error: 'That token cannot reach any Cloudflare account.' }, 400)
  }

  const release = await latestRelease(HEDGE_REPO)
  if (!release) {
    return json({ error: `${HEDGE_REPO} has no published release to install yet.` }, 502)
  }

  return json({ accounts, version: release.tag_name } satisfies AccountsResponse)
}

/**
 * Run an install, streaming each step to the page as it happens.
 *
 * Server-sent events rather than a single long request: provisioning, uploading a few megabytes of
 * assets and applying migrations takes long enough that a page with no output looks hung, and the
 * step that is running is exactly what an operator needs when something goes wrong.
 */
async function handleInstall(request: Request): Promise<Response> {
  const input = (await request.json()) as InstallRequest
  const token = input.token?.trim() ?? ''
  const name = input.name?.trim() ?? ''

  if (!token || !input.accountId || !name) {
    return json({ error: 'A token, an account and a name are all required.' }, 400)
  }
  if (!/^[a-z0-9][a-z0-9-]{0,52}$/.test(name)) {
    return json(
      {
        error:
          'The name must be lowercase letters, numbers and hyphens, starting with a letter or number. It becomes your Worker name and part of your URL.',
      },
      400,
    )
  }

  const client = cloudflareClient(input.accountId, token)

  // Both checks happen before anything is created: an occupied script name would otherwise be
  // discovered by overwriting somebody else's Worker, and a release with no artifact attached would
  // be discovered after provisioning a database and a bucket.
  try {
    if (!(await nameAvailable(client, name))) {
      return json(
        { error: `This account already has a Worker named "${name}". Choose another name.` },
        409,
      )
    }
  } catch (error) {
    return json(
      { error: `Could not check that name against your account: ${describe(error)}` },
      502,
    )
  }

  const release = await latestRelease(HEDGE_REPO)
  if (!release) return json({ error: 'There is no published Hedge release to install.' }, 502)

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))

      const fail = (message: string) => {
        const result: InstallResult = {
          ok: false,
          url: null,
          version: release.tag_name,
          steps: [],
          created: [],
          message,
        }
        send({ type: 'done', result })
        controller.close()
      }

      // Downloading and verifying the artifact happens here, inside the stream, because it is the
      // slowest thing that can fail and the page should say so rather than sit on a dead request.
      let artifact: Awaited<ReturnType<typeof fetchReleaseArtifact>>
      try {
        artifact = await fetchReleaseArtifact(release)
      } catch (error) {
        return fail(
          `Could not download the Hedge ${release.tag_name} release artifact: ${describe(error)}. Nothing was created on your account.`,
        )
      }

      try {
        const result = await runInstall({
          client,
          artifact,
          name,
          appName: input.appName?.trim() || 'Hedge',
          emailFrom: input.emailFrom?.trim() ?? '',
          emailFromName: input.emailFromName?.trim() ?? '',
          onEvent: send,
        })
        send({ type: 'done', result })
      } catch (error) {
        // `runInstall` turns every expected failure into a result; reaching here means something
        // genuinely unforeseen, and the operator still needs to be told rather than left waiting.
        fail(`The install stopped unexpectedly: ${describe(error)}`)
        return
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  })
}

const page = renderPage(await bundleClient())

const server = Bun.serve({
  port: PORT,
  // Loopback only. This process accepts a Cloudflare API token; it has no business being reachable
  // from anywhere but the machine running it.
  hostname: '127.0.0.1',

  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(page, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    try {
      if (request.method === 'POST' && url.pathname === '/api/accounts') {
        return await handleAccounts(request)
      }
      if (request.method === 'POST' && url.pathname === '/api/install') {
        return await handleInstall(request)
      }
    } catch (error) {
      return json({ error: describe(error) }, 500)
    }

    return new Response('Not found', { status: 404 })
  },
})

const url = `http://127.0.0.1:${server.port}`
console.log(`\n  Hedge installer running at ${url}`)
console.log('  Your Cloudflare API token stays on this machine — see docs/spikes/37-…\n')
console.log('  Press Ctrl+C when the install is finished.\n')

// Open the operator's browser. Strictly best-effort, and wrapped because `Bun.spawn` *throws*
// rather than rejecting when the opener isn't on PATH — a headless Linux box without `xdg-open`
// would otherwise take the whole installer down at the moment it had just started successfully.
const opener =
  process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
try {
  Bun.spawn([opener, url], { stdout: 'ignore', stderr: 'ignore' }).exited.catch(() => {})
} catch {
  console.log(`  (Couldn't open a browser automatically — open ${url} yourself.)\n`)
}
