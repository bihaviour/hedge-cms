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

/**
 * CMS operators. `owner` and `admin` run the instance and reach every site; `editor` and
 * `viewer` here is only the default role they are granted with — what they can actually reach
 * lives in `site_users`.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** `null` until the user accepts their invite and sets a password. */
    passwordHash: text('password_hash'),
    role: text('role', { enum: ['owner', 'admin', 'editor', 'viewer'] })
      .notNull()
      .default('editor'),
    ...timestamps,
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

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/** Single-use tokens for invites and password resets. */
export const authTokens = sqliteTable(
  'auth_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['invite', 'password_reset'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [uniqueIndex('auth_tokens_hash_idx').on(t.tokenHash)],
)

/**
 * Website visitors, scoped to a single site. Kept apart from `users` on purpose: a member has no
 * role, no session cookie and no route into the admin — only a bearer token that unlocks the
 * `members`-visibility content of their own site.
 */
export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** `null` when an admin added the member before they chose a password. */
    passwordHash: text('password_hash'),
    status: text('status', { enum: ['active', 'blocked'] })
      .notNull()
      .default('active'),
    lastLoginAt: text('last_login_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('members_site_email_idx').on(t.siteId, t.email)],
)

export const memberSessions = sqliteTable(
  'member_sessions',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index('member_sessions_member_idx').on(t.memberId)],
)

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
export type MemberRow = typeof members.$inferSelect
export type CollectionRow = typeof collections.$inferSelect
export type EntryRow = typeof entries.$inferSelect
export type MediaRow = typeof media.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
