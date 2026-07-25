import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
}

/**
 * Better Auth hands its adapter `Date` objects for every date field, so the tables it owns store
 * epoch seconds rather than the ISO strings the content tables use. Anything crossing the wire is
 * converted back to ISO at the route boundary.
 */
const authTimestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}

/**
 * The tenant boundary. One deployment holds many sites; everything content-shaped below hangs
 * off a `siteId`, so a blog and a docs site can each have their own `pages` collection.
 */
export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Public hostname of the website this site feeds — used to resolve the tenant from `Host`. */
    domain: text('domain'),
    allowMemberSignup: integer('allow_member_signup', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('sites_slug_idx').on(t.slug), uniqueIndex('sites_domain_idx').on(t.domain)],
)

/* ------------------------------------------------------------------ *
 * CMS operators — the `user` model of the Better Auth instance in `auth/cms.ts`.
 * ------------------------------------------------------------------ */

/**
 * `owner` and `admin` run the instance and reach every site; `editor` and `viewer` here is only
 * the default role a user is granted with — what they can actually reach lives in `site_users`.
 *
 * Passwords are not here: Better Auth keeps credentials in `accounts`, so one identity can grow
 * a second sign-in method later without this table changing shape.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    role: text('role', { enum: ['owner', 'admin', 'editor', 'viewer'] })
      .notNull()
      .default('editor'),
    ...authTimestamps,
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
)

/**
 * Which sites a user can reach, and as what. Owners and admins run the instance and are not
 * listed here — they reach every site. For everyone else this table *is* their access: no row,
 * no site.
 */
export const siteUsers = sqliteTable(
  'site_users',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'editor', 'viewer'] })
      .notNull()
      .default('editor'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId] }), index('site_users_user_idx').on(t.userId)],
)

/**
 * Admin sessions. `token` is the value in the signed cookie; Better Auth rotates it as the
 * session is refreshed and deletes the row on sign-out, so revocation is a delete away.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    /** Kept so a user can recognise — and revoke — a session they do not remember starting. */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...authTimestamps,
  },
  (t) => [uniqueIndex('sessions_token_idx').on(t.token), index('sessions_user_idx').on(t.userId)],
)

/** Credentials and linked providers. A password sign-in is `providerId = 'credential'`. */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    idToken: text('id_token'),
    ...authTimestamps,
  },
  (t) => [
    index('accounts_user_idx').on(t.userId),
    uniqueIndex('accounts_provider_account_idx').on(t.providerId, t.accountId),
  ],
)

/**
 * Short-lived values Better Auth needs to look up by identifier: email verification, password
 * reset, and the OAuth authorization codes the MCP flow issues.
 */
export const verifications = sqliteTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    ...authTimestamps,
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
)

/**
 * Better Auth's rate-limit counters. Backed by the database rather than memory on purpose: a
 * Worker isolate is short-lived and there are many of them, so an in-memory counter would let a
 * password-guessing loop reset its own budget by being routed to a new isolate.
 *
 * Shared by both auth instances — keys are derived from the request path, which never collides.
 */
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    /** Epoch milliseconds. Better Auth compares it against `Date.now()` directly. */
    lastRequest: integer('last_request').notNull(),
  },
  (t) => [uniqueIndex('rate_limits_key_idx').on(t.key)],
)

/** Single-use invite tokens. Password resets are Better Auth's `verifications` rows instead. */
export const authTokens = sqliteTable(
  'auth_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['invite'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [uniqueIndex('auth_tokens_hash_idx').on(t.tokenHash)],
)

/* ------------------------------------------------------------------ *
 * OAuth 2.1 — the MCP authorization server. Clients register themselves, users approve them, and
 * the resulting access tokens act for that user against `/api/v1/mcp`.
 * ------------------------------------------------------------------ */

export const oauthApplications = sqliteTable(
  'oauth_applications',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    icon: text('icon'),
    metadata: text('metadata'),
    clientId: text('client_id').notNull(),
    /** Null for public clients, which authenticate with PKCE instead of a secret. */
    clientSecret: text('client_secret'),
    /** Comma-separated, as Better Auth stores it. */
    redirectUrls: text('redirect_urls').notNull(),
    type: text('type').notNull(),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    /** The user who registered the client, when it was registered from a session. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    ...authTimestamps,
  },
  (t) => [uniqueIndex('oauth_applications_client_id_idx').on(t.clientId)],
)

export const oauthAccessTokens = sqliteTable(
  'oauth_access_tokens',
  {
    id: text('id').primaryKey(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }).notNull(),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }).notNull(),
    clientId: text('client_id').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Space-separated scope list. */
    scopes: text('scopes').notNull(),
    ...authTimestamps,
  },
  (t) => [
    uniqueIndex('oauth_access_tokens_access_idx').on(t.accessToken),
    uniqueIndex('oauth_access_tokens_refresh_idx').on(t.refreshToken),
    index('oauth_access_tokens_user_idx').on(t.userId),
  ],
)

export const oauthConsents = sqliteTable(
  'oauth_consents',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: text('scopes').notNull(),
    consentGiven: integer('consent_given', { mode: 'boolean' }).notNull().default(false),
    ...authTimestamps,
  },
  (t) => [index('oauth_consents_user_client_idx').on(t.userId, t.clientId)],
)

/* ------------------------------------------------------------------ *
 * Website members — the `user` model of the *second* Better Auth instance, in `auth/member.ts`.
 *
 * Two instances rather than a role column: the admin instance cannot resolve a member session at
 * all, so no credential a member holds is even representable as a CMS user.
 * ------------------------------------------------------------------ */

/**
 * One identity per deployment, not per site. A reader of the blog who also reads the docs site is
 * one account with two grants in `member_sites` — which is what lets them keep one password, and
 * what keeps "is this email known here?" answerable in one place.
 */
export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    ...authTimestamps,
  },
  (t) => [uniqueIndex('members_email_idx').on(t.email)],
)

/**
 * A member's access to one site. This row *is* their membership: no row, no gated content, and no
 * appearance in that site's member list. `status` lives here so one site can block a reader
 * without touching their access to another.
 */
export const memberSites = sqliteTable(
  'member_sites',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['active', 'blocked'] })
      .notNull()
      .default('active'),
    lastLoginAt: text('last_login_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.memberId] }),
    index('member_sites_member_idx').on(t.memberId),
  ],
)

/**
 * Member sessions. The token is handed to the website as a bearer value rather than a cookie: a
 * member signs in on a different origin, so there is no cookie the CMS could set for them.
 */
export const memberSessions = sqliteTable(
  'member_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...authTimestamps,
  },
  (t) => [
    uniqueIndex('member_sessions_token_idx').on(t.token),
    index('member_sessions_member_idx').on(t.userId),
  ],
)

export const memberAccounts = sqliteTable(
  'member_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    idToken: text('id_token'),
    ...authTimestamps,
  },
  (t) => [
    index('member_accounts_member_idx').on(t.userId),
    uniqueIndex('member_accounts_provider_account_idx').on(t.providerId, t.accountId),
  ],
)

export const memberVerifications = sqliteTable(
  'member_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    ...authTimestamps,
  },
  (t) => [index('member_verifications_identifier_idx').on(t.identifier)],
)

/* ------------------------------------------------------------------ *
 * Delivery keys and content.
 * ------------------------------------------------------------------ */

/**
 * Per-site keys for the read-only delivery API — the one bearer token a website frontend holds.
 * They are resolved only on `/api/v1/content/*`: a key that serves a public website has no path
 * into the management API or the MCP endpoint.
 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    /** Keys are issued per site, so a blog key cannot read the docs site. */
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    /** JSON array of scope strings. */
    scopes: text('scopes', { mode: 'json' }).notNull().$type<string[]>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [uniqueIndex('api_keys_hash_idx').on(t.keyHash), index('api_keys_site_idx').on(t.siteId)],
)

export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind', { enum: ['multiple', 'single'] })
      .notNull()
      .default('multiple'),
    /** JSON array of field definitions — see `@hedge/core`'s `fieldsSchema`. */
    fields: text('fields', { mode: 'json' }).notNull().$type<unknown[]>(),
    ...timestamps,
  },
  // Slugs are unique per site, not per deployment — every site gets its own namespace.
  (t) => [uniqueIndex('collections_site_slug_idx').on(t.siteId, t.slug)],
)

export const entries = sqliteTable(
  'entries',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    status: text('status', { enum: ['draft', 'published', 'archived'] })
      .notNull()
      .default('draft'),
    /** `members` entries are withheld from the delivery API without a member token. */
    visibility: text('visibility', { enum: ['public', 'members'] })
      .notNull()
      .default('public'),
    locale: text('locale').notNull().default('en'),
    data: text('data', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    publishedAt: text('published_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('entries_collection_slug_locale_idx').on(t.collectionId, t.slug, t.locale),
    index('entries_collection_status_idx').on(t.collectionId, t.status),
    index('entries_updated_at_idx').on(t.updatedAt),
  ],
)

/** Immutable snapshot of an entry's data, written on every update. */
export const entryRevisions = sqliteTable(
  'entry_revisions',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    data: text('data', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    status: text('status').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index('entry_revisions_entry_idx').on(t.entryId, t.createdAt)],
)

export const media = sqliteTable(
  'media',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    alt: text('alt'),
    uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('media_key_idx').on(t.key),
    index('media_site_created_at_idx').on(t.siteId, t.createdAt),
  ],
)

export type SiteRow = typeof sites.$inferSelect
export type SiteUserRow = typeof siteUsers.$inferSelect
export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type MemberRow = typeof members.$inferSelect
export type MemberSiteRow = typeof memberSites.$inferSelect
export type CollectionRow = typeof collections.$inferSelect
export type EntryRow = typeof entries.$inferSelect
export type MediaRow = typeof media.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type OAuthApplicationRow = typeof oauthApplications.$inferSelect
