import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
}

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

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
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
  (t) => [uniqueIndex('api_keys_hash_idx').on(t.keyHash)],
)

export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
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
  (t) => [uniqueIndex('collections_slug_idx').on(t.slug)],
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
  (t) => [uniqueIndex('media_key_idx').on(t.key), index('media_created_at_idx').on(t.createdAt)],
)

export type UserRow = typeof users.$inferSelect
export type CollectionRow = typeof collections.$inferSelect
export type EntryRow = typeof entries.$inferSelect
export type MediaRow = typeof media.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
