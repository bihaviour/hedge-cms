import type {
  AnalyticsEntryStat,
  AnalyticsMetric,
  AnalyticsOverview,
  AnalyticsPoint,
  AnalyticsRange,
  AnalyticsRangeQuery,
  AnalyticsReferrerStat,
  AnalyticsShareStat,
  AnalyticsTimeseries,
  ApiErrorBody,
  ApiKey,
  AttachTranslationInput,
  AuthorizedClient,
  Collection,
  CreateApiKeyInput,
  CreateCollectionInput,
  CreateEmailSenderInput,
  CreateEntryInput,
  CreateEntryVersionInput,
  CreateMemberInput,
  CreateNewsletterInput,
  CreateNewsletterTemplateInput,
  CreateRoleInput,
  CreateSiteInput,
  CreateSiteResult,
  CreateSubscriberInput,
  EmailConfig,
  EmailLog,
  EmailSender,
  EmailTemplate,
  EmailTemplateKey,
  EmailTemplatePreview,
  Entry,
  EntryRevision,
  EntryTranslation,
  EntryVersion,
  ListEntriesQuery,
  ListMediaQuery,
  LoginResult,
  Media,
  Member,
  Newsletter,
  NewsletterAnalytics,
  NewsletterAudience,
  NewsletterDelivery,
  NewsletterPreview,
  NewsletterPreviewInput,
  NewsletterTemplate,
  PageQuery,
  Paginated,
  PreviewToken,
  ReviewQueueItem,
  RoleDefinition,
  SendResult,
  Site,
  SiteAccess,
  SiteAuthority,
  SiteRole,
  Subscriber,
  SystemUpdateInput,
  SystemUpdateResult,
  SystemVersion,
  TrustedDevice,
  UpdateApiKeyInput,
  UpdateCollectionInput,
  UpdateEmailConfigInput,
  UpdateEmailSenderInput,
  UpdateEmailTemplateInput,
  UpdateEntryInput,
  UpdateEntryVersionInput,
  UpdateMemberInput,
  UpdateNewsletterInput,
  UpdateNewsletterTemplateInput,
  UpdateRoleInput,
  UpdateSenderAssignmentInput,
  UpdateSiteConfigInput,
  UpdateSiteInput,
  UpdateSubscriberInput,
  User,
  UserSession,
  VerifyLoginCodeInput,
} from '@hedge/core'
import { getActiveSite, setActiveSite, siteHeaders } from './active-site'

const BASE = '/api/v1'

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

/**
 * One request, with the remembered site attached — and dropped again if the API says it is gone.
 *
 * A site can be deleted while someone has it selected, and the slug outlives it in `localStorage`.
 * Every request carries that header, so without this the *session* check itself would fail and the
 * admin would show its login screen to someone who is perfectly well signed in, with no way out but
 * clearing site data. Forgetting the site and asking again is the whole recovery: the switcher
 * falls back to the first site the account can reach as soon as the app renders.
 */
async function send(path: string, init?: RequestInit): Promise<Response> {
  const call = () =>
    fetch(`${BASE}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        // Every content route is scoped to the site the admin is currently in.
        ...siteHeaders(),
        ...init?.headers,
      },
    })

  const response = await call()
  if (response.status !== 404 || !getActiveSite()) return response

  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as ApiErrorBody | null
  if (body?.error.code !== 'unknown_site') return response

  setActiveSite(null)
  return call()
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init)

  if (response.status === 204) return undefined as T

  const payload = await response.json().catch(() => null)

  if (!response.ok) throw errorFrom(response, payload)

  return (payload as { data: T }).data
}

/**
 * A multipart upload, with byte progress — the one call in this client that is not `fetch`.
 *
 * `fetch` can report a *response* arriving and nothing at all about a request body going out: a
 * streamed body needs `duplex: 'half'`, is HTTP/2-only, and still exposes no callback. A progress
 * bar per file is most of the value of picking ten files at once, so this path is `XMLHttpRequest`
 * — which has had upload progress since before `fetch` existed. Same-origin cookies ride along by
 * default, so the session is attached exactly as `send` attaches it.
 *
 * It mirrors `send`'s unknown-site recovery for the reason described there, which a batch upload
 * only sharpens: a slug that outlived its site would fail every file in the queue.
 */
async function upload<T>(
  path: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  const call = () =>
    new Promise<{ status: number; statusText: string; payload: unknown }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${BASE}${path}`)
      for (const [key, value] of Object.entries(siteHeaders())) xhr.setRequestHeader(key, value)

      // `lengthComputable` is false for the last event of some transfers; ignoring those keeps the
      // bar from jumping back to zero on the way to `done`.
      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
        }
      }

      xhr.onload = () => {
        let payload: unknown = null
        try {
          payload = JSON.parse(xhr.responseText)
        } catch {
          payload = null
        }
        resolve({ status: xhr.status, statusText: xhr.statusText, payload })
      }
      // A dropped connection and an aborted request are both "this file did not upload", which is
      // what the queue renders; neither carries an API error body to read a code out of.
      xhr.onerror = () => reject(new ApiClientError(0, 'network_error', 'Upload failed'))
      xhr.ontimeout = () => reject(new ApiClientError(0, 'network_error', 'Upload timed out'))
      xhr.onabort = () => reject(new ApiClientError(0, 'aborted', 'Upload cancelled'))

      xhr.send(form)
    })

  let result = await call()
  if (result.status === 404 && getActiveSite()) {
    const body = result.payload as ApiErrorBody | null
    if (body?.error.code === 'unknown_site') {
      setActiveSite(null)
      result = await call()
    }
  }

  if (result.status < 200 || result.status >= 300) {
    const body = result.payload as ApiErrorBody | null
    throw new ApiClientError(
      result.status,
      body?.error.code ?? 'internal_error',
      body?.error.message ?? result.statusText,
      body?.error.details,
    )
  }

  return (result.payload as { data: T }).data
}

function errorFrom(response: Response, payload: unknown): ApiClientError {
  const body = payload as ApiErrorBody | null
  return new ApiClientError(
    response.status,
    body?.error.code ?? 'internal_error',
    body?.error.message ?? response.statusText,
    body?.error.details,
  )
}

const json = (body: unknown) => ({ body: JSON.stringify(body) })

/** `?a=1&b=2` from an object, dropping anything unset. Empty when nothing survives. */
function params(query: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  )
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

export const api = {
  auth: {
    setupRequired: () => request<{ setupRequired: boolean }>('/auth/setup-required'),
    setup: (input: { email: string; name: string; password: string }) =>
      request<User>('/auth/setup', { method: 'POST', ...json(input) }),
    /**
     * Either signs in, or reports that a code has been mailed because this browser is not one the
     * account has been seen on. Callers have to narrow on `verificationRequired` — see `LoginResult`.
     */
    login: (input: { email: string; password: string }) =>
      request<LoginResult>('/auth/login', { method: 'POST', ...json(input) }),
    verifyLoginCode: (input: VerifyLoginCodeInput) =>
      request<LoginResult>('/auth/login/verify', { method: 'POST', ...json(input) }),
    resendLoginCode: (input: { challengeId: string }) =>
      request<{ expiresAt: string }>('/auth/login/resend', { method: 'POST', ...json(input) }),
    logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
    me: () => request<User>('/auth/me'),
    invite: (input: { email: string; name: string; role: string }) =>
      request<User>('/auth/invite', { method: 'POST', ...json(input) }),
    /** Sends the "set your password" email again, replacing the outstanding link. */
    resendInvite: (id: string) =>
      request<{ ok: true }>(`/auth/invite/${id}/resend`, { method: 'POST' }),
    acceptInvite: (input: { token: string; password: string }) =>
      request<User>('/auth/accept-invite', { method: 'POST', ...json(input) }),
    forgotPassword: (input: { email: string }) =>
      request<{ ok: true }>('/auth/forgot-password', { method: 'POST', ...json(input) }),
    resetPassword: (input: { token: string; password: string }) =>
      request<{ ok: true }>('/auth/reset-password', { method: 'POST', ...json(input) }),
    changePassword: (input: { currentPassword: string; newPassword: string }) =>
      request<{ ok: true }>('/auth/change-password', { method: 'POST', ...json(input) }),

    /**
     * Browsers that skip the sign-in code. Revoking one means the next sign-in from it is mailed a
     * code again — it does not end a session, which is what `sessions` is for.
     */
    devices: () => request<TrustedDevice[]>('/auth/devices'),
    revokeDevice: (id: string) => request<void>(`/auth/devices/${id}`, { method: 'DELETE' }),

    /** Where this account is signed in. Revoking is by id — the token never leaves the server. */
    sessions: () => request<UserSession[]>('/auth/sessions'),
    revokeSession: (id: string) => request<void>(`/auth/sessions/${id}`, { method: 'DELETE' }),
    revokeAllSessions: () => request<{ ok: true }>('/auth/sessions/revoke-all', { method: 'POST' }),

    /** The MCP client behind an in-flight authorization request, for the consent screen. */
    oauthPending: (clientId: string) =>
      request<{ clientId: string; name: string; icon: string | null }>(
        `/auth/oauth/pending?client_id=${encodeURIComponent(clientId)}`,
      ),
    oauthClients: () => request<AuthorizedClient[]>('/auth/oauth/clients'),
    revokeOauthClient: (clientId: string) =>
      request<void>(`/auth/oauth/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
  },

  /** The signed-in person's own role and approval level on the active site — what the UI gates on. */
  access: {
    get: () => request<SiteAuthority>('/access'),
  },

  sites: {
    list: () => request<Site[]>('/sites'),
    // Creating a site also issues its delivery key (unless opted out), so the result carries both
    // the site and the raw key secret — shown once, in the create-site UI.
    create: (input: CreateSiteInput) =>
      request<CreateSiteResult>('/sites', { method: 'POST', ...json(input) }),
    update: (slug: string, input: UpdateSiteInput) =>
      request<Site>(`/sites/${slug}`, { method: 'PATCH', ...json(input) }),
    /** A site's own metadata defaults and custom fields — authorised at the site level. */
    updateConfig: (slug: string, input: UpdateSiteConfigInput) =>
      request<Site>(`/sites/${slug}/config`, { method: 'PATCH', ...json(input) }),
    remove: (slug: string) => request<void>(`/sites/${slug}`, { method: 'DELETE' }),
  },

  /** Admin-side management of one site's members. `pending` means they have not set a password. */
  members: {
    list: (query: PageQuery & { q?: string } = {}) => {
      return requestPage<Member & { pending: boolean }>(`/members${listParams(query)}`)
    },
    create: (input: CreateMemberInput) =>
      request<Member & { pending: boolean }>('/members', { method: 'POST', ...json(input) }),
    update: (id: string, input: UpdateMemberInput) =>
      request<Member>(`/members/${id}`, { method: 'PATCH', ...json(input) }),
    remove: (id: string) => request<void>(`/members/${id}`, { method: 'DELETE' }),
    /** Sends the "choose a password" email again. */
    invite: (id: string) => request<{ ok: true }>(`/members/${id}/invite`, { method: 'POST' }),
  },

  /**
   * The public member API, which the admin normally has no business calling. The exception is the
   * reset page: with no site domain configured, a member's emailed link lands here, and the token
   * has to go back to the member instance that issued it.
   */
  member: {
    resetPassword: (input: { token: string; password: string }) =>
      request<{ ok: true }>('/member/reset-password', { method: 'POST', ...json(input) }),
  },

  users: {
    list: () => request<(User & { pending: boolean })[]>('/users'),
    update: (id: string, input: { name?: string; role?: string }) =>
      request<User>(`/users/${id}`, { method: 'PATCH', ...json(input) }),
    remove: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),

    /** Per-site grants. Only meaningful for editors and viewers — admins reach every site. */
    siteAccess: (id: string) => request<SiteAccess[]>(`/users/${id}/sites`),
    /**
     * `approvalLevel` omitted leaves whatever is stored alone, so changing the role does not
     * silently reset the approval authority; `null` clears the override back to the role's default.
     */
    grantSite: (id: string, siteId: string, role: SiteRole, approvalLevel?: number | null) =>
      request<SiteAccess>(`/users/${id}/sites/${siteId}`, {
        method: 'PUT',
        ...json({ role, ...(approvalLevel === undefined ? {} : { approvalLevel }) }),
      }),
    revokeSite: (id: string, siteId: string) =>
      request<void>(`/users/${id}/sites/${siteId}`, { method: 'DELETE' }),
  },

  /**
   * Instance roles — the built-in four plus any the deployment has defined. `list` is readable by
   * any signed-in user (the invite and role dropdowns need it); writing is gated on `roles:manage`.
   */
  roles: {
    list: () => request<RoleDefinition[]>('/roles'),
    create: (input: CreateRoleInput) =>
      request<RoleDefinition>('/roles', { method: 'POST', ...json(input) }),
    update: (slug: string, input: UpdateRoleInput) =>
      request<RoleDefinition>(`/roles/${slug}`, { method: 'PATCH', ...json(input) }),
    remove: (slug: string) => request<void>(`/roles/${slug}`, { method: 'DELETE' }),
  },

  collections: {
    list: () => request<Collection[]>('/collections'),
    get: (slug: string) => request<Collection>(`/collections/${slug}`),
    create: (input: CreateCollectionInput) =>
      request<Collection>('/collections', { method: 'POST', ...json(input) }),
    update: (slug: string, input: UpdateCollectionInput) =>
      request<Collection>(`/collections/${slug}`, { method: 'PATCH', ...json(input) }),
    remove: (slug: string) => request<void>(`/collections/${slug}`, { method: 'DELETE' }),
  },

  entries: {
    list: (collection: string, query: Partial<ListEntriesQuery> = {}) => {
      const params = new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([key, value]) => [key, String(value)]),
      )
      return requestPage<Entry>(`/collections/${collection}/entries?${params}`)
    },
    get: (collection: string, slug: string, locale = 'en') =>
      request<Entry>(`/collections/${collection}/entries/${slug}?locale=${locale}`),
    create: (collection: string, input: CreateEntryInput) =>
      request<Entry>(`/collections/${collection}/entries`, { method: 'POST', ...json(input) }),
    update: (collection: string, slug: string, input: UpdateEntryInput, locale = 'en') =>
      request<Entry>(`/collections/${collection}/entries/${slug}?locale=${locale}`, {
        method: 'PATCH',
        ...json(input),
      }),
    remove: (collection: string, slug: string, locale = 'en') =>
      request<void>(`/collections/${collection}/entries/${slug}?locale=${locale}`, {
        method: 'DELETE',
      }),
    /** Point-in-time snapshots, newest first — one is written before every edit. */
    revisions: (collection: string, slug: string, locale = 'en') =>
      request<EntryRevision[]>(
        `/collections/${collection}/entries/${slug}/revisions?locale=${locale}`,
      ),
    restore: (collection: string, slug: string, revisionId: string, locale = 'en') =>
      request<Entry>(
        `/collections/${collection}/entries/${slug}/revisions/${revisionId}/restore?locale=${locale}`,
        { method: 'POST' },
      ),
    /**
     * Mints a short-lived link that renders this entry, unpublished, in the website's own layout.
     * The response carries a ready-built `url` — the server owns the template expansion so the
     * admin and any other client point at the same place. Null when the site has no preview URL.
     */
    previewToken: (collection: string, slug: string, locale = 'en') =>
      request<PreviewToken>(`/collections/${collection}/entries/${slug}/preview-token`, {
        method: 'POST',
        ...json({ locale }),
      }),

    /**
     * The languages one post is written in. An entry and its translations are one piece with a row
     * per language, and each row has its own slug — so this, not the slug, is what the editor's
     * locale switcher navigates by.
     */
    translations: (collection: string, slug: string) =>
      request<EntryTranslation[]>(`/collections/${collection}/entries/${slug}/translations`),
    /**
     * Merge an entry that already exists into this post, bringing every language it already has.
     * Neither side takes a locale — a slug names one post whichever language it is written in.
     */
    linkTranslation: (collection: string, slug: string, link: AttachTranslationInput) =>
      request<EntryTranslation[]>(`/collections/${collection}/entries/${slug}/translations`, {
        method: 'POST',
        ...json(link),
      }),
    /** Split one language out into a post of its own. The locale here is what is being removed. */
    unlinkTranslation: (collection: string, slug: string, locale: string) =>
      request<Entry>(`/collections/${collection}/entries/${slug}/translations/${locale}`, {
        method: 'DELETE',
      }),
  },

  /**
   * Proposed future states of an entry — the forward-looking counterpart to `entries.revisions`.
   * Every call is scoped to one entry in one locale, the way the routes are.
   */
  entryVersions: {
    list: (collection: string, slug: string, locale = 'en') =>
      request<EntryVersion[]>(
        `/collections/${collection}/entries/${slug}/versions?locale=${locale}`,
      ),
    create: (collection: string, slug: string, input: CreateEntryVersionInput, locale = 'en') =>
      request<EntryVersion>(
        `/collections/${collection}/entries/${slug}/versions?locale=${locale}`,
        {
          method: 'POST',
          ...json(input),
        },
      ),
    update: (
      collection: string,
      slug: string,
      versionId: string,
      input: UpdateEntryVersionInput,
      locale = 'en',
    ) =>
      request<EntryVersion>(
        `/collections/${collection}/entries/${slug}/versions/${versionId}?locale=${locale}`,
        { method: 'PATCH', ...json(input) },
      ),
    /** Abandons a version. It is kept as `discarded` so the decisions on it survive. */
    discard: (collection: string, slug: string, versionId: string, locale = 'en') =>
      request<EntryVersion>(
        `/collections/${collection}/entries/${slug}/versions/${versionId}?locale=${locale}`,
        { method: 'DELETE' },
      ),
    submit: (collection: string, slug: string, versionId: string, locale = 'en') =>
      request<EntryVersion>(
        `/collections/${collection}/entries/${slug}/versions/${versionId}/submit?locale=${locale}`,
        { method: 'POST' },
      ),
    /** `approve` and `reject` take the same body; the comment is what a rejection needs. */
    decide: (
      collection: string,
      slug: string,
      versionId: string,
      decision: 'approve' | 'reject',
      comment: string | undefined,
      locale = 'en',
    ) =>
      request<EntryVersion>(
        `/collections/${collection}/entries/${slug}/versions/${versionId}/${decision}?locale=${locale}`,
        { method: 'POST', ...json({ comment }) },
      ),
    publish: (collection: string, slug: string, versionId: string, locale = 'en') =>
      request<{ version: EntryVersion; entry: Entry }>(
        `/collections/${collection}/entries/${slug}/versions/${versionId}/publish?locale=${locale}`,
        { method: 'POST' },
      ),
  },

  /** The review inbox for the active site. What the caller may approve on it is `access` above. */
  review: {
    queue: (query: PageQuery = {}) =>
      requestPage<ReviewQueueItem>(`/review/queue${listParams(query)}`),
    count: () => request<{ count: number }>('/review/queue/count'),
  },

  media: {
    list: (query: Partial<ListMediaQuery> = {}) => {
      const params = new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([key, value]) => [key, String(value)]),
      )
      return requestPage<Media>(`/media?${params}`)
    },
    /**
     * One file per request, on purpose. Several files in one multipart body would upload as one
     * thing: a single progress number, and one failure — a type the deployment refuses, a file
     * over the cap — taking down the whole batch, since the route streams each body straight into
     * R2 and cannot half-succeed usefully. Uploading many is therefore many calls, run as a
     * bounded queue by `useMediaUploads`, so each file has its own progress and its own outcome.
     */
    upload: (file: File, alt?: string, onProgress?: (fraction: number) => void) => {
      const form = new FormData()
      form.set('file', file)
      if (alt) form.set('alt', alt)
      return upload<Media>('/media', form, onProgress)
    },
    update: (id: string, input: { alt?: string | null; filename?: string }) =>
      request<Media>(`/media/${id}`, { method: 'PATCH', ...json(input) }),
    remove: (id: string) => request<void>(`/media/${id}`, { method: 'DELETE' }),
  },

  apiKeys: {
    list: () => request<ApiKey[]>('/api-keys'),
    create: (input: CreateApiKeyInput) =>
      request<ApiKey & { key: string }>('/api-keys', { method: 'POST', ...json(input) }),
    /** Renames a key. Scopes are fixed at issue — see `updateApiKeySchema`. */
    update: (id: string, input: UpdateApiKeyInput) =>
      request<ApiKey>(`/api-keys/${id}`, { method: 'PATCH', ...json(input) }),
    /**
     * Issues a new secret and returns it, invalidating the old one. The only way back from a lost
     * key: nothing stores the original, so it cannot be shown again.
     */
    rotate: (id: string) =>
      request<ApiKey & { key: string }>(`/api-keys/${id}/rotate`, { method: 'POST' }),
    remove: (id: string) => request<void>(`/api-keys/${id}`, { method: 'DELETE' }),
  },

  /** Deployment-wide email management: system templates, the send log, and sender config. */
  email: {
    templates: () => request<EmailTemplate[]>('/email/templates'),
    template: (key: EmailTemplateKey) => request<EmailTemplate>(`/email/templates/${key}`),
    updateTemplate: (key: EmailTemplateKey, input: UpdateEmailTemplateInput) =>
      request<EmailTemplate>(`/email/templates/${key}`, { method: 'PUT', ...json(input) }),
    /** Removes the override, restoring the built-in default. */
    resetTemplate: (key: EmailTemplateKey) =>
      request<EmailTemplate>(`/email/templates/${key}`, { method: 'DELETE' }),
    /** Renders an unsaved draft with sample data for the editor's preview. */
    previewTemplate: (key: EmailTemplateKey, input: UpdateEmailTemplateInput) =>
      request<EmailTemplatePreview>(`/email/templates/${key}/preview`, {
        method: 'POST',
        ...json(input),
      }),

    log: (query: PageQuery = {}) => requestPage<EmailLog>(`/email/log${listParams(query)}`),

    config: () => request<EmailConfig>('/email/config'),
    updateConfig: (input: UpdateEmailConfigInput) =>
      request<EmailConfig>('/email/config', { method: 'PATCH', ...json(input) }),

    /** The active site's sender address book (#136). Returned whole; paged in the client. */
    senders: () => request<EmailSender[]>('/email/senders'),
    createSender: (input: CreateEmailSenderInput) =>
      request<EmailSender>('/email/senders', { method: 'POST', ...json(input) }),
    updateSender: (id: string, input: UpdateEmailSenderInput) =>
      request<EmailSender>(`/email/senders/${id}`, { method: 'PATCH', ...json(input) }),
    removeSender: (id: string) => request<void>(`/email/senders/${id}`, { method: 'DELETE' }),
    /** Sets which listed address is the site's member and newsletter sender. Returns the site. */
    assignSenders: (input: UpdateSenderAssignmentInput) =>
      request<Site>('/email/senders/assignments', { method: 'PUT', ...json(input) }),
  },

  /** Per-site newsletter subscriber list. `pending` has no meaning here — everyone is just an email. */
  subscribers: {
    list: (query: PageQuery & { q?: string } = {}) =>
      requestPage<Subscriber>(`/subscribers${listParams(query)}`),
    create: (input: CreateSubscriberInput) =>
      request<Subscriber>('/subscribers', { method: 'POST', ...json(input) }),
    update: (id: string, input: UpdateSubscriberInput) =>
      request<Subscriber>(`/subscribers/${id}`, { method: 'PATCH', ...json(input) }),
    remove: (id: string) => request<void>(`/subscribers/${id}`, { method: 'DELETE' }),
  },

  /** Per-site newsletter campaigns. */
  newsletters: {
    list: (query: PageQuery = {}) => requestPage<Newsletter>(`/newsletters${listParams(query)}`),
    get: (id: string) => request<Newsletter>(`/newsletters/${id}`),
    create: (input: CreateNewsletterInput) =>
      request<Newsletter>('/newsletters', { method: 'POST', ...json(input) }),
    update: (id: string, input: UpdateNewsletterInput) =>
      request<Newsletter>(`/newsletters/${id}`, { method: 'PATCH', ...json(input) }),
    remove: (id: string) => request<void>(`/newsletters/${id}`, { method: 'DELETE' }),
    /** How many recipients the given audience would reach right now. */
    recipientCount: (audience: NewsletterAudience) =>
      request<{ count: number }>(`/newsletters/recipients/count?audience=${audience}`),
    test: (id: string, email: string) =>
      request<{ ok: true }>(`/newsletters/${id}/test`, { method: 'POST', ...json({ email }) }),
    send: (id: string) => request<SendResult>(`/newsletters/${id}/send`, { method: 'POST' }),
  },

  /** Reusable newsletter blueprints for this site. */
  newsletterTemplates: {
    list: () => request<NewsletterTemplate[]>('/newsletter-templates'),
    create: (input: CreateNewsletterTemplateInput) =>
      request<NewsletterTemplate>('/newsletter-templates', { method: 'POST', ...json(input) }),
    update: (id: string, input: UpdateNewsletterTemplateInput) =>
      request<NewsletterTemplate>(`/newsletter-templates/${id}`, {
        method: 'PATCH',
        ...json(input),
      }),
    remove: (id: string) => request<void>(`/newsletter-templates/${id}`, { method: 'DELETE' }),
    preview: (input: NewsletterPreviewInput) =>
      request<NewsletterPreview>('/newsletter-templates/preview', {
        method: 'POST',
        ...json(input),
      }),
  },

  /**
   * Website analytics for the active site. Every range is resolved on the server, in the site's
   * timezone — the admin passes `from`/`to` through and never derives a day boundary of its own,
   * because two different answers to "what is today" is how these screens start disagreeing with
   * each other.
   */
  analytics: {
    overview: (range: AnalyticsRangeQuery = {}) =>
      request<AnalyticsOverview & { collecting: boolean }>(`/analytics/overview${params(range)}`),
    timeseries: (
      query: AnalyticsRangeQuery & { metric?: AnalyticsMetric; entryId?: string } = {},
    ) => request<AnalyticsTimeseries>(`/analytics/timeseries${params(query)}`),
    entries: (query: AnalyticsRangeQuery & { limit?: number } = {}) =>
      request<AnalyticsEntryStat[]>(`/analytics/entries${params(query)}`),
    /** One article's traffic — reachable from the ranked table and from the entry editor. */
    entry: (entryId: string, range: AnalyticsRangeQuery = {}) =>
      request<{
        entryId: string
        title: string | null
        range: AnalyticsRange
        views: number
        previousViews: number
        shareIntents: number
        series: AnalyticsPoint[]
        previousSeries: AnalyticsPoint[]
      }>(`/analytics/entries/${entryId}${params(range)}`),
    referrers: (query: AnalyticsRangeQuery & { limit?: number } = {}) =>
      request<AnalyticsReferrerStat[]>(`/analytics/referrers${params(query)}`),
    shares: (query: AnalyticsRangeQuery & { limit?: number } = {}) =>
      request<AnalyticsShareStat[]>(`/analytics/shares${params(query)}`),
    /** Campaign delivery and audience movement — no collector involved. */
    newsletters: (range: AnalyticsRangeQuery = {}) =>
      request<NewsletterAnalytics>(`/analytics/newsletters${params(range)}`),
    newsletter: (id: string) => request<NewsletterDelivery>(`/analytics/newsletters/${id}`),
  },

  /** Deployment-level version and update awareness. Admin-only on the server. */
  system: {
    /**
     * The running version against the latest upstream release. The server answer is edge-cached for
     * six hours, so `refresh` is what an operator who has just published one needs — it skips that
     * cache (and is rate limited server-side, since the budget it spends is GitHub's).
     */
    version: (refresh = false) =>
      request<SystemVersion>(`/system/version${refresh ? '?refresh=1' : ''}`),
    /**
     * Move the deployment to a newer release. Owner-only on the server. The Cloudflare token is sent
     * once and never stored anywhere — not here, not on the server. The result carries a per-step
     * outcome so a partial failure can be shown as one.
     */
    update: (input: SystemUpdateInput) =>
      request<SystemUpdateResult>('/system/update', { method: 'POST', ...json(input) }),
  },
}

/**
 * Same as `request`, but preserves the whole page envelope — `nextCursor` to page with, and `total`
 * to render "of 137" from. `request` unwraps to `data` and would drop both.
 */
/**
 * Query string for a list request, dropping anything unset so `?limit=&cursor=` never goes out and
 * a page-one request stays a clean cache key.
 */
function listParams(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  )
  return params.size ? `?${params}` : ''
}

async function requestPage<T>(path: string): Promise<Paginated<T>> {
  const response = await send(path)
  const payload = await response.json().catch(() => null)

  if (!response.ok) throw errorFrom(response, payload)

  return payload as Paginated<T>
}
