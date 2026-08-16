import { EMAIL_STATUSES, EMAIL_TEMPLATE_KEYS } from '@hedge/core'
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
    /** Content locales this site publishes, e.g. `["en","id"]`. Entries live once per locale. */
    locales: text('locales', { mode: 'json' }).notNull().$type<string[]>().default(['en']),
    /** Which enabled locale the delivery API serves when a request names none. */
    defaultLocale: text('default_locale').notNull().default('en'),
    /** IANA timezone the admin renders this site's timestamps in. */
    timezone: text('timezone').notNull().default('UTC'),
    /**
     * Per-site metadata defaults and reusable custom field definitions — see `@hedge/core`'s
     * `siteMetadataSchema` and `fieldsSchema`. Null on older rows and freshly created sites; the
     * route boundary parses them into empty defaults.
     */
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    customFields: text('custom_fields', { mode: 'json' }).$type<unknown[]>(),
    /**
     * This site's sender for the transactional email its **members** receive — invite, password
     * reset, verification, sign-in link. Null on each column means inherit: the deployment's
     * `email_config` row, then `EMAIL_FROM` / `EMAIL_FROM_NAME`. They live on `sites` rather than in
     * a table of their own because every request already resolves this row, so a send costs no
     * extra query. Operator email never reads them; see `siteEmailSenderSchema` in `@hedge/core`.
     *
     * **Superseded by `memberSenderId` (#136)** and no longer read — the member sender is a managed
     * `email_senders` row now, not free text. Kept so the migration stays additive; unused.
     */
    emailFrom: text('email_from'),
    emailFromName: text('email_from_name'),
    emailReplyTo: text('email_reply_to'),
    /**
     * This site's default sender for its **newsletters**, separate from the member sender above. A
     * single newsletter can override it per campaign (`newsletters.from_email` …), so this is the
     * fallback when a campaign names none. Same inherit-on-null rule and same reasoning as above.
     *
     * **Superseded by `newsletterSenderId` (#136)** and no longer read — the sender is a managed
     * `email_senders` row now, not free text. Kept so the migration stays additive; unused.
     */
    newsletterFrom: text('newsletter_from'),
    newsletterFromName: text('newsletter_from_name'),
    newsletterReplyTo: text('newsletter_reply_to'),
    /**
     * Which `email_senders` row is this site's member sender, and which its newsletter sender (#136).
     * Null means inherit the global CMS sender (`email_config`). Plain id columns rather than DB
     * foreign keys because they are added by `ALTER TABLE`, which SQLite will not do with a FK; the
     * dangling-reference case is handled where they are read (a deleted sender resolves to null).
     */
    memberSenderId: text('member_sender_id'),
    newsletterSenderId: text('newsletter_sender_id'),
    /**
     * Base URL of this website's own preview endpoint, and whether the admin may frame it. Null and
     * false mean "no preview configured" — see `previewUrlSchema` in `@hedge/core`. Explicit rather
     * than derived from `domain`: a preview needs a route that knows how to *accept* a token, and
     * guessing one would produce a Preview button that mostly 404s.
     */
    previewUrl: text('preview_url'),
    previewEmbed: integer('preview_embed', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex('sites_slug_idx').on(t.slug), uniqueIndex('sites_domain_idx').on(t.domain)],
)

/* ------------------------------------------------------------------ *
 * CMS operators — the `user` model of the Better Auth instance in `auth/cms.ts`.
 * ------------------------------------------------------------------ */

/**
 * `role` is a role *slug* — a built-in (`owner`/`admin`/`editor`/`viewer`) or one an operator
 * defined under Settings → Roles. What the slug grants at the instance level is the permission set
 * on that role (built-in ones in `@hedge/core`, custom ones in `roles` below); what a user can
 * actually reach on a site still lives in `site_users`. It is a plain text column rather than an
 * enum so a custom slug is a valid value.
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
    role: text('role').notNull().default('editor'),
    ...authTimestamps,
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
)

/**
 * Operator-defined instance roles. Only *custom* roles live here — the four built-ins are fixed in
 * `@hedge/core` so their powers cannot drift and an owner cannot edit themselves out of control.
 * `permissions` is a JSON array of instance-permission ids; `slug` is what `users.role` references,
 * so it is permanent once assigned.
 */
export const roles = sqliteTable(
  'roles',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    permissions: text('permissions', { mode: 'json' }).$type<string[]>().notNull().default([]),
    defaultSiteRole: text('default_site_role', { enum: ['admin', 'editor', 'viewer'] }),
    ...timestamps,
  },
  (t) => [uniqueIndex('roles_slug_idx').on(t.slug)],
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
    /**
     * What this user may approve on this site — see `entry_versions` below. Null means "derive it
     * from the site role", which is what keeps every grant that predates the workflow behaving as
     * it always did. It lives here rather than in a table of its own because approval is a site
     * power and this row already *is* someone's site access, resolved on every request anyway.
     */
    approvalLevel: integer('approval_level'),
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
 * Step-up verification on an unrecognised device
 *
 * Between "the password was right" and "here is a session" sits a mailed code. These two tables are
 * that gap: one row per challenge in flight, and one per browser that has since been vouched for.
 * ------------------------------------------------------------------ */

/**
 * A sign-in that has passed the password and is waiting on a mailed code.
 *
 * `sessionCookies` holds the `Set-Cookie` values Better Auth already produced, parked here until the
 * code is entered rather than sent to a browser that has not proved anything yet. Keeping them
 * server-side is what lets the second step finish a sign-in it has no password for — Better Auth
 * owns identity, and re-deriving a session cookie ourselves would be forging one of its credentials.
 *
 * That does put a live session credential in D1 for a few minutes, which is worth being explicit
 * about: it is the *same* class of secret `sessions.token` already is (Better Auth stores those
 * unhashed), so it widens no boundary — and the row is deleted the moment it is used, fails, or
 * lapses, along with the orphaned session it refers to.
 */
export const loginChallenges = sqliteTable(
  'login_challenges',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC of the mailed code. Never the code — an inbox is not the only place this leaks from. */
    codeHash: text('code_hash').notNull(),
    /** JSON array of the parked `Set-Cookie` values. */
    sessionCookies: text('session_cookies', { mode: 'json' }).notNull().$type<string[]>(),
    /** The session row those cookies address, so an abandoned challenge can take it with it. */
    sessionToken: text('session_token'),
    /** Wrong codes so far. At `LOGIN_CODE_MAX_ATTEMPTS` the row is spent, not merely refused. */
    attempts: integer('attempts').notNull().default(0),
    /** Recorded for the email's "attempted from" line, and for the device row if trust is granted. */
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    /** Epoch seconds. */
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index('login_challenges_user_idx').on(t.userId)],
)

/**
 * A browser this account has vouched for with a code. Presence of a live row is what makes a
 * sign-in skip the second step.
 *
 * The cookie carries an opaque random id and the row stores only `hmac(AUTH_SECRET, id)`, so a
 * dumped table yields nothing presentable — the same construction delivery keys and invite tokens
 * use. Trust is per user *and* device, so two accounts on one laptop vouch for it separately.
 */
export const trustedDevices = sqliteTable(
  'trusted_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceHash: text('device_hash').notNull(),
    /** Best-effort description from the user agent, for the account page. Display only. */
    label: text('label').notNull(),
    lastUsedAt: text('last_used_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** Epoch seconds. */
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('trusted_devices_hash_idx').on(t.deviceHash),
    index('trusted_devices_user_idx').on(t.userId),
  ],
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

/**
 * What the operator narrowed when they approved an MCP client — **ours, not Better Auth's** (#145).
 *
 * It is a separate table rather than a column on `oauth_consents` for the reason the whole project
 * splits these: Better Auth owns identity and writes that row itself, from its own consent endpoint,
 * with the scopes the *client* asked for. This records what the *operator* decided on top, and the
 * two answer different questions.
 *
 * It could not be a scope either. A scope is requested by the client, and no client that exists
 * today knows to ask for one Hedge invented — so a `destructive` scope would be absent from every
 * request and would refuse every delete on the day it shipped. Turning the question around, so the
 * operator grants rather than the client requests, is what makes it a decision somebody makes.
 *
 * **A missing row means granted**, exactly as `INSTALLED_BY` unset means "show both": every consent
 * given before this existed has none, and must keep working as it did. The row is only ever written
 * to record a narrowing.
 */
export const mcpClientGrants = sqliteTable(
  'mcp_client_grants',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Whether this client may reach the tools that delete or overwrite. Default true. */
    destructive: integer('destructive', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('mcp_client_grants_user_client_idx').on(t.userId, t.clientId)],
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
    /** Whether this member receives the site's newsletter. Cleared by the unsubscribe link, so a
     * member can drop the newsletter without losing their account or gated-content access. */
    newsletterSubscribed: integer('newsletter_subscribed', { mode: 'boolean' })
      .notNull()
      .default(true),
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
    /**
     * How many approvals a version of one of this collection's entries must clear before it can be
     * published. `0` — the default, and what every collection that predates this column has —
     * switches the workflow off entirely, so the epic ships inert.
     */
    approvalLevels: integer('approval_levels').notNull().default(0),
    /**
     * Path template appended to the site's `previewUrl` for one entry of this collection, with
     * `{collection}`, `{slug}` and `{locale}` placeholders. Null falls back to the default shape.
     */
    previewPath: text('preview_path'),
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
    /**
     * Which *piece* this row is one language of. All the locale variants of one post share it, and
     * it is what makes them a single post rather than several that happen to look alike.
     *
     * It is a plain column rather than a table of its own: a group has no attributes — it is an
     * identity, and a row for it would only ever be a primary key. Deleting the last variant
     * therefore retires the group by having nothing left that references it.
     *
     * Grouping used to be implied by `slug`, which is why the backfill (`0014`) is
     * `(collection_id, slug)`. Slugs are now per-locale, so the implication no longer holds and the
     * link has to be recorded.
     */
    translationGroupId: text('translation_group_id').notNull(),
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
    /** SEO/social overrides and this entry's values for the site's custom fields; see `entryMetadataSchema`. */
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    publishedAt: text('published_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('entries_collection_slug_locale_idx').on(t.collectionId, t.slug, t.locale),
    index('entries_collection_status_idx').on(t.collectionId, t.status),
    index('entries_updated_at_idx').on(t.updatedAt),
    // Reading one post's other languages, which every delivery read now does to answer a fallback.
    index('entries_translation_group_idx').on(t.translationGroupId, t.locale),
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
    // Nullable: rows written before revisions captured metadata have none, and a restore reads it
    // back as "no override" rather than inventing empty defaults that would clobber the entry's.
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    status: text('status').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index('entry_revisions_entry_idx').on(t.entryId, t.createdAt)],
)

/**
 * A proposed *future* state of an entry — the forward-looking counterpart to `entry_revisions`
 * above, which records what an entry was. Several may be open on one entry at once, which is what
 * lets two people write the same article without the second write erasing the first.
 *
 * Publishing a version is what writes the live row; until then the delivery API cannot see it at all.
 */
export const entryVersions = sqliteTable(
  'entry_versions',
  {
    id: text('id').primaryKey(),
    /**
     * Carried rather than reached by joining `entry_versions → entries → collections`. The review
     * queue is a per-site query and `siteId` is the tenant boundary every content query filters on,
     * so making it two hops away would be paying for the join on the one query that matters most.
     */
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    entryId: text('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    /** The author's own summary — "added the interview section". What makes a list of three legible. */
    title: text('title').notNull(),
    data: text('data', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    /** Nullable for the same reason as a revision's: null publishes without touching the entry's. */
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    status: text('status', {
      enum: ['draft', 'in_review', 'changes_requested', 'approved', 'published', 'discarded'],
    })
      .notNull()
      .default('draft'),
    /** The live entry's `updatedAt` when this version forked. Behind it now means a stale base. */
    baseUpdatedAt: text('base_updated_at').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: text('submitted_at'),
    publishedAt: text('published_at'),
    ...timestamps,
  },
  (t) => [
    index('entry_versions_entry_idx').on(t.entryId, t.createdAt),
    // The review queue: one site's versions in one status, without touching another tenant's rows.
    index('entry_versions_site_status_idx').on(t.siteId, t.status),
  ],
)

/**
 * One recorded decision on a version, never updated in place. A version's progress is *derived*
 * from these rows (`clearedLevels` in `@hedge/core`) rather than duplicated into a counter column,
 * so the audit trail and the state cannot drift apart.
 *
 * Two rules this table cannot express live in the write path instead, with tests: an approver may
 * not be the version's author, and one person may not satisfy both levels.
 */
export const entryVersionApprovals = sqliteTable(
  'entry_version_approvals',
  {
    id: text('id').primaryKey(),
    versionId: text('version_id')
      .notNull()
      .references(() => entryVersions.id, { onDelete: 'cascade' }),
    /** 1 or 2 — the level this decision satisfies. Levels are cleared in order. */
    level: integer('level').notNull(),
    decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    comment: text('comment'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index('entry_version_approvals_version_idx').on(t.versionId, t.createdAt)],
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

/* ------------------------------------------------------------------ *
 * Email. Templates, a log of every send, and sender configuration.
 *
 * These are deployment-level, not site-scoped: there is one Cloudflare Email binding and one
 * onboarded `from` domain per deployment, so email is infrastructure the instance owns rather than
 * content a tenant owns — the same reason it sits behind the instance-admin role in the admin, next
 * to users and sites.
 * ------------------------------------------------------------------ */

/**
 * An override of a built-in system email. A row exists only when an operator has customised that
 * template; its absence is what "use the default" means. Keyed by `key`, one row per template.
 */
export const emailTemplates = sqliteTable(
  'email_templates',
  {
    id: text('id').primaryKey(),
    key: text('key', { enum: EMAIL_TEMPLATE_KEYS }).notNull(),
    subject: text('subject').notNull(),
    heading: text('heading').notNull(),
    body: text('body').notNull(),
    ctaLabel: text('cta_label'),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('email_templates_key_idx').on(t.key)],
)

/** A record of every email Hedge composed, whether it was sent, skipped, or rejected. */
export const emailLog = sqliteTable(
  'email_log',
  {
    id: text('id').primaryKey(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    /** The template that produced it, or null for a one-off. */
    templateKey: text('template_key', { enum: EMAIL_TEMPLATE_KEYS }),
    /**
     * The campaign this send belongs to, for anything sent by `sendNewsletter`.
     *
     * Without it the only link from a log row back to its campaign was a matching subject line,
     * which breaks the first time two campaigns share one — so per-campaign delivery was not a query
     * anybody could write. `set null` rather than cascade: deleting a campaign should not erase the
     * record that it was sent. Rows written before this column existed keep null, which honestly
     * means "sent before this was recorded" rather than "not a newsletter".
     */
    newsletterId: text('newsletter_id').references(() => newsletters.id, { onDelete: 'set null' }),
    status: text('status', { enum: EMAIL_STATUSES }).notNull(),
    error: text('error'),
    // Ids are timestamp-prefixed, so paginating by id desc is newest-first without a second index.
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index('email_log_created_at_idx').on(t.createdAt),
    index('email_log_newsletter_idx').on(t.newsletterId),
  ],
)

/**
 * Singleton sender configuration, always stored under the id `default`. Overrides layer on top of
 * the `EMAIL_FROM` / `EMAIL_FROM_NAME` environment variables; a null column falls back to those.
 */
export const emailConfig = sqliteTable('email_config', {
  id: text('id').primaryKey(),
  fromEmail: text('from_email'),
  fromName: text('from_name'),
  replyTo: text('reply_to'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
})

/**
 * A site's address book of sender identities (#136). Each row is one address a site may send from,
 * with an optional display name and reply-to. Which of them is the site's member sender and which
 * is its newsletter sender is recorded on `sites` (`member_sender_id` / `newsletter_sender_id`), and
 * a newsletter may point at one directly (`newsletters.sender_id`) to send as its author.
 *
 * This replaces the free-text sender fields that used to live on `sites` and `newsletters`: a send
 * now names a *managed* identity rather than an address typed inline, so the same address is defined
 * once and reused. The global CMS sender stays separate — it is `email_config`, deployment-wide.
 *
 * `email` is unique per site so a picker never shows the same address twice; two sites may each hold
 * their own row for the same address, since sending is scoped by tenant.
 */
export const emailSenders = sqliteTable(
  'email_senders',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name'),
    replyTo: text('reply_to'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_senders_site_email_idx').on(t.siteId, t.email),
    index('email_senders_site_idx').on(t.siteId, t.createdAt),
  ],
)

/* ------------------------------------------------------------------ *
 * Newsletters. Per-site — a newsletter is audience content, so it hangs off `siteId` like
 * collections and members, unlike the deployment-level email management above.
 * ------------------------------------------------------------------ */

/**
 * A per-site list of newsletter recipients that are not necessarily members: just an email address,
 * a name, and whether they are still subscribed. Public signup adds a row; the unsubscribe link
 * flips its status rather than deleting it, so a re-subscribe is recognisable and an address is
 * never silently re-added after opting out.
 */
export const newsletterSubscribers = sqliteTable(
  'newsletter_subscribers',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name'),
    status: text('status', { enum: ['subscribed', 'unsubscribed'] })
      .notNull()
      .default('subscribed'),
    source: text('source'),
    unsubscribedAt: text('unsubscribed_at'),
    ...timestamps,
  },
  (t) => [
    // One row per address per site; a site gets its own list.
    uniqueIndex('newsletter_subscribers_site_email_idx').on(t.siteId, t.email),
    index('newsletter_subscribers_site_idx').on(t.siteId),
  ],
)

/** A newsletter campaign. Draft until sent; `recipientCount` and `sentAt` are filled on send. */
export const newsletters = sqliteTable(
  'newsletters',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: ['draft', 'sending', 'sent'] })
      .notNull()
      .default('draft'),
    audience: text('audience', { enum: ['subscribers', 'members', 'both'] })
      .notNull()
      .default('both'),
    /**
     * This campaign's own sender override (#134). **Superseded by `senderId` (#136)** and no longer
     * read — kept so the migration stays additive; unused.
     */
    fromEmail: text('from_email'),
    fromName: text('from_name'),
    replyTo: text('reply_to'),
    /**
     * The `email_senders` row this campaign sends as (#136), letting an author send one newsletter
     * as themselves. Null means the site's newsletter sender. A plain id column, for the reason on
     * `sites.memberSenderId`; a deleted sender resolves to the site default.
     */
    senderId: text('sender_id'),
    sentAt: text('sent_at'),
    recipientCount: integer('recipient_count'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('newsletters_site_idx').on(t.siteId, t.createdAt)],
)

/** A reusable newsletter blueprint — a named subject and body a new campaign can be started from. */
export const newsletterTemplates = sqliteTable(
  'newsletter_templates',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('newsletter_templates_site_idx').on(t.siteId, t.createdAt)],
)

/* ------------------------------------------------------------------ *
 * Website analytics. Per-site, like everything else content-shaped.
 * ------------------------------------------------------------------ */

/**
 * Pre-aggregated daily counters — there is deliberately **no raw event table**.
 *
 * D1 is SQLite at the edge and has no TTL: a row per pageview turns a modest website into a database
 * nobody can query, and the rows stay until something deletes them. The collector UPSERTs into these
 * buckets instead, so the row count is bounded by `sites × days × dimensions` and a traffic spike
 * touches the same rows harder rather than adding new ones. A million hits on one article on one day
 * is one row. The dimension caps in `@hedge/core`'s `analytics.ts` are what bound the last term,
 * because the collector is a public write path and an attacker posting invented paths must not be
 * able to grow the table.
 *
 * `date` is `YYYY-MM-DD` **in the site's timezone**. `sites.timezone` exists for exactly this: a day
 * cut in UTC would file an Indonesian site's evening traffic under the following day, and the
 * operator reading the chart would have no way to tell.
 *
 * v1 does not count unique visitors. Doing so needs per-visitor state — a row per visitor per day,
 * even hashed and salted — which is precisely the unbounded growth this shape exists to avoid, and
 * it turns a deployment with nothing to explain in a privacy policy into one with something to
 * explain. Views, share intents and referrers are what a CMS dashboard actually acts on.
 */
export const analyticsDaily = sqliteTable(
  'analytics_daily',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `YYYY-MM-DD` in the site's timezone. Sorts and compares lexicographically. */
    date: text('date').notNull(),
    /**
     * The entry this bucket's path resolved to when it was first written, or null for a path that
     * matches no entry (a listing page, a landing page, a 404 somebody linked). `set null` rather
     * than cascade: deleting an article should not silently erase the traffic it earned.
     */
    entryId: text('entry_id').references(() => entries.id, { onDelete: 'set null' }),
    /** The normalised URL path, or `''` for a site-wide bucket such as a referral. */
    path: text('path').notNull().default(''),
    metric: text('metric', { enum: ['view', 'share_intent', 'referral'] }).notNull(),
    /** The metric's dimension: the share target, the referrer host. Empty for a plain view. */
    key: text('key').notNull().default(''),
    count: integer('count').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    /**
     * The bucket identity, and what the collector's UPSERT conflicts on.
     *
     * `entryId` is **not** in it, though it is part of what a bucket describes. SQLite treats NULLs
     * as distinct inside a unique index, so a nullable column here would mean every view of a
     * non-entry path conflicted with nothing and inserted a new row — the exact unbounded growth
     * this table is shaped to prevent, and it would look fine until a site had a page without an
     * entry. It costs nothing to leave out: `entryId` is resolved *from* the path, so two rows with
     * the same path on the same day always agree on it.
     */
    uniqueIndex('analytics_daily_bucket_idx').on(t.siteId, t.date, t.path, t.metric, t.key),
    /** Every dashboard and reporting query starts here. */
    index('analytics_daily_site_date_idx').on(t.siteId, t.date),
    /** One article's traffic since publication — the per-entry view. */
    index('analytics_daily_site_entry_idx').on(t.siteId, t.entryId, t.date),
  ],
)

export type SiteRow = typeof sites.$inferSelect
export type SiteUserRow = typeof siteUsers.$inferSelect
export type UserRow = typeof users.$inferSelect
export type RoleRow = typeof roles.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type LoginChallengeRow = typeof loginChallenges.$inferSelect
export type TrustedDeviceRow = typeof trustedDevices.$inferSelect
export type MemberRow = typeof members.$inferSelect
export type MemberSiteRow = typeof memberSites.$inferSelect
export type CollectionRow = typeof collections.$inferSelect
export type EntryRow = typeof entries.$inferSelect
export type EntryVersionRow = typeof entryVersions.$inferSelect
export type EntryVersionApprovalRow = typeof entryVersionApprovals.$inferSelect
export type MediaRow = typeof media.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type OAuthApplicationRow = typeof oauthApplications.$inferSelect
export type EmailTemplateRow = typeof emailTemplates.$inferSelect
export type EmailLogRow = typeof emailLog.$inferSelect
export type EmailConfigRow = typeof emailConfig.$inferSelect
export type EmailSenderRow = typeof emailSenders.$inferSelect
export type NewsletterSubscriberRow = typeof newsletterSubscribers.$inferSelect
export type NewsletterRow = typeof newsletters.$inferSelect
export type NewsletterTemplateRow = typeof newsletterTemplates.$inferSelect
export type AnalyticsDailyRow = typeof analyticsDaily.$inferSelect
export type McpClientGrantRow = typeof mcpClientGrants.$inferSelect
