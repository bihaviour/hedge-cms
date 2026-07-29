import type {
  ApiErrorBody,
  ApiKey,
  AuthorizedClient,
  Collection,
  CreateApiKeyInput,
  CreateCollectionInput,
  CreateEntryInput,
  CreateMemberInput,
  CreateNewsletterInput,
  CreateNewsletterTemplateInput,
  CreateRoleInput,
  CreateSiteInput,
  CreateSiteResult,
  CreateSubscriberInput,
  EmailConfig,
  EmailLog,
  EmailTemplate,
  EmailTemplateKey,
  EmailTemplatePreview,
  Entry,
  EntryRevision,
  ListEntriesQuery,
  Media,
  Member,
  Newsletter,
  NewsletterAudience,
  NewsletterPreview,
  NewsletterTemplate,
  RoleDefinition,
  SendResult,
  Site,
  SiteAccess,
  SiteRole,
  Subscriber,
  SystemUpdateInput,
  SystemUpdateResult,
  SystemVersion,
  UpdateCollectionInput,
  UpdateEmailConfigInput,
  UpdateEmailTemplateInput,
  UpdateEntryInput,
  UpdateMemberInput,
  UpdateNewsletterInput,
  UpdateNewsletterTemplateInput,
  UpdateRoleInput,
  UpdateSiteConfigInput,
  UpdateSiteInput,
  UpdateSubscriberInput,
  User,
  UserSession,
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

export const api = {
  auth: {
    setupRequired: () => request<{ setupRequired: boolean }>('/auth/setup-required'),
    setup: (input: { email: string; name: string; password: string }) =>
      request<User>('/auth/setup', { method: 'POST', ...json(input) }),
    login: (input: { email: string; password: string }) =>
      request<User>('/auth/login', { method: 'POST', ...json(input) }),
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
    list: (query: { q?: string; cursor?: string } = {}) => {
      const params = new URLSearchParams(
        Object.entries(query).filter(([, value]) => value) as [string, string][],
      )
      return requestPage<Member & { pending: boolean }>(`/members?${params}`)
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
    grantSite: (id: string, siteId: string, role: SiteRole) =>
      request<SiteAccess>(`/users/${id}/sites/${siteId}`, { method: 'PUT', ...json({ role }) }),
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
  },

  media: {
    list: (cursor?: string) =>
      requestPage<Media>(`/media${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    upload: (file: File, alt?: string) => {
      const form = new FormData()
      form.set('file', file)
      if (alt) form.set('alt', alt)
      return request<Media>('/media', { method: 'POST', body: form })
    },
    update: (id: string, input: { alt?: string | null; filename?: string }) =>
      request<Media>(`/media/${id}`, { method: 'PATCH', ...json(input) }),
    remove: (id: string) => request<void>(`/media/${id}`, { method: 'DELETE' }),
  },

  apiKeys: {
    list: () => request<ApiKey[]>('/api-keys'),
    create: (input: CreateApiKeyInput) =>
      request<ApiKey & { key: string }>('/api-keys', { method: 'POST', ...json(input) }),
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

    log: (cursor?: string) =>
      requestPage<EmailLog>(`/email/log${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),

    config: () => request<EmailConfig>('/email/config'),
    updateConfig: (input: UpdateEmailConfigInput) =>
      request<EmailConfig>('/email/config', { method: 'PATCH', ...json(input) }),
  },

  /** Per-site newsletter subscriber list. `pending` has no meaning here — everyone is just an email. */
  subscribers: {
    list: (query: { q?: string; cursor?: string } = {}) => {
      const params = new URLSearchParams(
        Object.entries(query).filter(([, value]) => value) as [string, string][],
      )
      return requestPage<Subscriber>(`/subscribers?${params}`)
    },
    create: (input: CreateSubscriberInput) =>
      request<Subscriber>('/subscribers', { method: 'POST', ...json(input) }),
    update: (id: string, input: UpdateSubscriberInput) =>
      request<Subscriber>(`/subscribers/${id}`, { method: 'PATCH', ...json(input) }),
    remove: (id: string) => request<void>(`/subscribers/${id}`, { method: 'DELETE' }),
  },

  /** Per-site newsletter campaigns. */
  newsletters: {
    list: (cursor?: string) =>
      requestPage<Newsletter>(
        `/newsletters${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
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
    preview: (input: { subject: string; body: string }) =>
      request<NewsletterPreview>('/newsletter-templates/preview', {
        method: 'POST',
        ...json(input),
      }),
  },

  /** Deployment-level version and update awareness. Admin-only on the server. */
  system: {
    version: () => request<SystemVersion>('/system/version'),
    /**
     * Move the deployment to a newer release. Owner-only on the server. The Cloudflare token is sent
     * once and never stored anywhere — not here, not on the server. The result carries a per-step
     * outcome so a partial failure can be shown as one.
     */
    update: (input: SystemUpdateInput) =>
      request<SystemUpdateResult>('/system/update', { method: 'POST', ...json(input) }),
  },
}

/** Same as `request`, but preserves the `nextCursor` alongside the rows. */
async function requestPage<T>(path: string): Promise<{ data: T[]; nextCursor: string | null }> {
  const response = await send(path)
  const payload = await response.json().catch(() => null)

  if (!response.ok) throw errorFrom(response, payload)

  return payload as { data: T[]; nextCursor: string | null }
}
