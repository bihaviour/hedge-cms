import type {
  AccountsResponse,
  InstallEvent,
  InstallResult,
  InstallStep,
  StepState,
} from './protocol'
import { derivedNames, INSTALL_STEPS } from './protocol'

/**
 * The installer page's behaviour. Bundled by `server.ts` at start-up and inlined into the document,
 * so there is no build artifact to produce, stale or commit.
 *
 * It imports `derivedNames` from `protocol.ts` rather than re-deriving the names, so the preview
 * under the name field cannot drift from what actually gets created — the same reason a shape
 * crossing a wire is defined once. Importing it from `install.ts` would work and would also drag
 * `@hedge/deploy` and zod into a bundle that only needs three string concatenations.
 */

const STEP_LABELS: Record<InstallStep, string> = {
  database: 'Create the D1 database',
  bucket: 'Create the R2 bucket',
  migrations: 'Set up the database schema',
  assets: 'Upload the admin interface',
  worker: 'Upload and deploy the Worker',
  subdomain: 'Make it reachable',
}

const MARKERS: Record<StepState['status'], string> = {
  pending: '·',
  running: '⟳',
  done: '✓',
  skipped: '–',
  failed: '✗',
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const tokenInput = el<HTMLInputElement>('token')
const connectButton = el<HTMLButtonElement>('connect')
const tokenError = el<HTMLParagraphElement>('token-error')
const detailsStep = el<HTMLElement>('step-details')
const accountSelect = el<HTMLSelectElement>('account')
const nameInput = el<HTMLInputElement>('name')
const appNameInput = el<HTMLInputElement>('app-name')
const emailFromInput = el<HTMLInputElement>('email-from')
const emailFromNameInput = el<HTMLInputElement>('email-from-name')
const installButton = el<HTMLButtonElement>('install')
const installError = el<HTMLParagraphElement>('install-error')
const progressStep = el<HTMLElement>('step-progress')
const stepList = el<HTMLUListElement>('steps')
const resultBox = el<HTMLDivElement>('result')

function showError(node: HTMLElement, message: string | null): void {
  node.textContent = message ?? ''
  node.hidden = message === null
}

/** Keep the name previews honest by deriving them the way the installer will. */
function updatePreviews(): void {
  const names = derivedNames(nameInput.value.trim() || 'hedge-cms')
  el('url-preview').textContent = names.script
  el('db-preview').textContent = names.database
  el('bucket-preview').textContent = names.bucket
}

nameInput.addEventListener('input', updatePreviews)
updatePreviews()

connectButton.addEventListener('click', async () => {
  showError(tokenError, null)
  connectButton.disabled = true
  connectButton.textContent = 'Connecting…'

  try {
    const response = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenInput.value }),
    })
    const body = (await response.json()) as AccountsResponse & { error?: string }

    if (!response.ok) {
      showError(tokenError, body.error ?? 'Could not reach Cloudflare.')
      return
    }

    accountSelect.replaceChildren(
      ...body.accounts.map((account) => {
        const option = document.createElement('option')
        option.value = account.id
        option.textContent = `${account.name} (${account.id})`
        return option
      }),
    )
    el('version').textContent = body.version
    detailsStep.hidden = false
    detailsStep.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    showError(tokenError, `Could not reach the installer: ${error}`)
  } finally {
    connectButton.disabled = false
    connectButton.textContent = 'Connect'
  }
})

/** Render one step's line, creating it on first sight so the list fills in the order it runs. */
function renderStep(state: StepState): void {
  let item = stepList.querySelector<HTMLLIElement>(`[data-step="${state.step}"]`)
  if (!item) {
    item = document.createElement('li')
    item.dataset.step = state.step
    stepList.append(item)
  }
  item.dataset.status = state.status

  const marker = document.createElement('span')
  marker.className = 'marker'
  marker.textContent = MARKERS[state.status]

  const label = document.createElement('span')
  label.textContent = STEP_LABELS[state.step]

  item.replaceChildren(marker, label)
  if (state.detail) {
    const detail = document.createElement('span')
    detail.className = 'detail'
    detail.textContent = state.detail
    item.append(detail)
  }
}

function renderResult(result: InstallResult): void {
  const heading = document.createElement('h3')
  heading.textContent = result.ok ? `Hedge ${result.version} is installed` : 'The install stopped'

  const message = document.createElement('p')
  message.textContent = result.message

  resultBox.replaceChildren(heading, message)

  if (result.ok && result.url) {
    // Straight to `/setup`: a fresh deployment has no users, so the onboarding wizard is the only
    // thing there is to do next, and making the operator find it is a pointless last step.
    const link = document.createElement('p')
    const anchor = document.createElement('a')
    anchor.href = `${result.url}/setup`
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    anchor.textContent = `Open ${result.url} and create your account →`
    link.append(anchor)

    const note = document.createElement('p')
    note.className = 'hint'
    note.textContent =
      'A new deployment starts in the onboarding wizard, where you create the owner account and ' +
      'the first site. You can close this installer once you are there.'

    resultBox.append(link, note)
  }

  if (!result.ok && result.created.length > 0) {
    const created = document.createElement('pre')
    created.textContent = result.created
      .map(
        (resource) =>
          `${resource.created ? 'created' : 'reused '}  ${resource.kind.toUpperCase().padEnd(6)} ${resource.name}`,
      )
      .join('\n')
    resultBox.append(created)
  }

  resultBox.hidden = false
}

installButton.addEventListener('click', async () => {
  showError(installError, null)
  installButton.disabled = true
  progressStep.hidden = false
  resultBox.hidden = true

  // Seed every step as pending, so the operator sees the whole sequence rather than watching lines
  // appear one at a time with no idea how many are left.
  stepList.replaceChildren()
  for (const step of INSTALL_STEPS) renderStep({ step, status: 'pending', detail: null })
  progressStep.scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const response = await fetch('/api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: tokenInput.value,
        accountId: accountSelect.value,
        name: nameInput.value,
        appName: appNameInput.value,
        emailFrom: emailFromInput.value,
        emailFromName: emailFromNameInput.value,
      }),
    })

    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      showError(installError, body.error ?? 'The installer could not start.')
      progressStep.hidden = true
      return
    }

    for await (const event of readEvents(response.body)) {
      if (event.type === 'step') renderStep(event.state)
      if (event.type === 'done') renderResult(event.result)
    }
  } catch (error) {
    showError(installError, `The install was interrupted: ${error}`)
  } finally {
    installButton.disabled = false
  }
})

/** Server-sent events, parsed off the response body — no EventSource, because this is a POST. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<InstallEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // `stream: true` so a multi-byte character split across two chunks isn't mangled.
    buffer += decoder.decode(value, { stream: true })

    // Events are separated by a blank line; a partial one stays in the buffer until it completes.
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const payload = frame.startsWith('data: ') ? frame.slice(6) : null
      if (payload) yield JSON.parse(payload) as InstallEvent
      boundary = buffer.indexOf('\n\n')
    }
  }
}
