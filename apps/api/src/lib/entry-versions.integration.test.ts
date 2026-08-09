import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { collections, entries, type SiteRow, sites, siteUsers, users } from '../db/schema'

/**
 * The approval workflow against a real SQLite, built from the committed migrations — so the rules
 * the *table* cannot express are exercised where they actually live, in the write path.
 *
 * Four of these pin decisions the epic turns on: approving your own version, one person trying to
 * clear both levels, publishing a version that has only cleared level 1 of 2, and approving with an
 * approval level below the one being cleared. The fifth pins the publish bypass — a collection with
 * approval switched on must not be publishable in one `PATCH`, or the whole workflow is decorative.
 */

let db: ReturnType<typeof drizzle>

// The service reaches the database through `getDb`, so pointing that at an in-memory SQLite is all
// it takes to run the real queries. Notifications are stubbed: they are covered by their own
// module, and an email attempt here would only drag the email config tables in.
// Keeps every export the real module has: `mock.module` is process-wide and outlives this file,
// so one dropped here is an import error in whichever file runs next.
const realClient = await import('../db/client')
mock.module('../db/client', () => ({ ...realClient, getDb: () => db }))
mock.module('./review-notifications', () => ({
  notifyVersionSubmitted: async () => {},
  notifyVersionDecided: async () => {},
}))

const {
  createEntryVersion,
  decideEntryVersion,
  publishEntryVersion,
  submitEntryVersion,
  updateEntryVersion,
} = await import('./entry-versions')
const { updateEntry } = await import('./entries')

const MIGRATIONS = join(import.meta.dir, '../../migrations')

/**
 * Applies every committed migration in order. Statements are split on drizzle-kit's own breakpoint
 * marker, so this reads the same files a deployment does rather than a hand-kept copy of the schema
 * that would drift the first time a column is added.
 */
function migrate(sqlite: Database) {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
}

const site: SiteRow = {
  id: 'site_1',
  slug: 'blog',
  name: 'Blog',
  description: null,
  domain: null,
  allowMemberSignup: true,
  locales: ['en'],
  defaultLocale: 'en',
  timezone: 'UTC',
  metadata: null,
  customFields: null,
  emailFrom: null,
  emailFromName: null,
  emailReplyTo: null,
  newsletterFrom: null,
  newsletterFromName: null,
  newsletterReplyTo: null,
  memberSenderId: null,
  newsletterSenderId: null,
  previewUrl: null,
  previewEmbed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const env = {} as never

/** A collection needing `approvalLevels` approvals, with one draft entry in it. */
async function seed(approvalLevels: number) {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })

  await db.insert(sites).values(site)
  await db.insert(users).values([
    { id: 'usr_author', email: 'author@example.com', name: 'Author', role: 'editor' },
    { id: 'usr_one', email: 'one@example.com', name: 'One', role: 'editor' },
    { id: 'usr_two', email: 'two@example.com', name: 'Two', role: 'admin' },
  ])
  await db.insert(siteUsers).values([
    { siteId: site.id, userId: 'usr_author', role: 'editor' },
    { siteId: site.id, userId: 'usr_one', role: 'editor' },
    { siteId: site.id, userId: 'usr_two', role: 'admin' },
  ])
  await db.insert(collections).values({
    id: 'col_posts',
    siteId: site.id,
    slug: 'posts',
    name: 'Posts',
    kind: 'multiple',
    fields: [{ kind: 'text', name: 'title', label: 'Title' }],
    approvalLevels,
  })
  await db.insert(entries).values({
    id: 'ent_1',
    collectionId: 'col_posts',
    translationGroupId: 'tgr_1',
    slug: 'hello',
    status: 'draft',
    visibility: 'public',
    locale: 'en',
    data: { title: 'Hello' },
    metadata: null,
    createdBy: 'usr_author',
    updatedBy: 'usr_author',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}

/** A submitted version authored by `usr_author`, ready to be decided on. */
async function submittedVersion() {
  const created = await createEntryVersion(
    env,
    site,
    'posts',
    'hello',
    { title: 'Added the interview section', data: { title: 'Hello, revised' } },
    'usr_author',
  )
  return await submitEntryVersion(env, site, 'posts', 'hello', created.id)
}

const approve = (versionId: string, userId: string, approverLevel: number) =>
  decideEntryVersion(env, site, 'posts', 'hello', versionId, 'approved', { userId, approverLevel })

describe('entry version approvals', () => {
  beforeEach(async () => {
    await seed(2)
  })

  test('an author cannot approve their own version', async () => {
    const version = await submittedVersion()
    expect(approve(version.id, 'usr_author', 2)).rejects.toThrow('cannot review your own version')
  })

  test('one person cannot satisfy both levels', async () => {
    const version = await submittedVersion()
    const once = await approve(version.id, 'usr_two', 2)
    expect(once.status).toBe('in_review')

    expect(approve(version.id, 'usr_two', 2)).rejects.toThrow('already approved')
  })

  test('two different people clear both levels and the version becomes approved', async () => {
    const version = await submittedVersion()
    await approve(version.id, 'usr_one', 1)
    const done = await approve(version.id, 'usr_two', 2)

    expect(done.status).toBe('approved')
    expect(done.approvals.map((a) => a.level)).toEqual([1, 2])
  })

  test('an approval level below the level being cleared is refused', async () => {
    const version = await submittedVersion()
    await approve(version.id, 'usr_one', 1)

    // Level 2 is next now, and a level-1 approver cannot take it.
    expect(approve(version.id, 'usr_two', 1)).rejects.toThrow('approval level 2')
  })

  test('a rejection sends the version back and clears what it had earned', async () => {
    const version = await submittedVersion()
    await approve(version.id, 'usr_one', 1)

    const sentBack = await decideEntryVersion(env, site, 'posts', 'hello', version.id, 'rejected', {
      userId: 'usr_two',
      approverLevel: 2,
      comment: 'Needs a source',
    })
    expect(sentBack.status).toBe('changes_requested')

    // Editable again, and re-submitting starts the levels over rather than resuming at 2.
    await updateEntryVersion(env, site, 'posts', 'hello', version.id, { title: 'With a source' })
    const resubmitted = await submitEntryVersion(env, site, 'posts', 'hello', version.id)
    const next = await approve(resubmitted.id, 'usr_one', 1)
    expect(next.status).toBe('in_review')
  })

  test('a version in review cannot be edited', async () => {
    const version = await submittedVersion()
    expect(
      updateEntryVersion(env, site, 'posts', 'hello', version.id, { title: 'Sneaky' }),
    ).rejects.toThrow('can no longer be edited')
  })
})

describe('publishing a version', () => {
  test('a version that has cleared only level 1 of 2 cannot be published', async () => {
    await seed(2)
    const version = await submittedVersion()
    await approve(version.id, 'usr_one', 1)

    expect(publishEntryVersion(env, site, 'posts', 'hello', version.id, 'usr_two')).rejects.toThrow(
      'cleared 1 of the 2 approval(s)',
    )
  })

  test('a fully approved version publishes onto the live entry', async () => {
    await seed(1)
    const version = await submittedVersion()
    await approve(version.id, 'usr_two', 2)

    const result = await publishEntryVersion(env, site, 'posts', 'hello', version.id, 'usr_two')
    expect(result.version.status).toBe('published')
    expect(result.entry.status).toBe('published')
    expect(result.entry.data.title).toBe('Hello, revised')
    expect(result.entry.publishedAt).not.toBeNull()
  })

  /**
   * The bypass. This check lives in `updateEntry` rather than in the route, so it holds for the MCP
   * `update_entry` tool as well — a gate on the route alone would have a hole the whole MCP surface
   * fits through.
   */
  test('a direct publish is refused while approval is switched on', async () => {
    await seed(1)
    expect(
      updateEntry(env, site, 'posts', 'hello', { status: 'published' }, 'usr_author'),
    ).rejects.toThrow('requires 1 approval(s)')
  })

  test('editing the draft row itself stays allowed', async () => {
    await seed(1)
    const updated = await updateEntry(
      env,
      site,
      'posts',
      'hello',
      { data: { title: 'Still a draft' } },
      'usr_author',
    )
    expect(updated.data.title).toBe('Still a draft')
    expect(updated.status).toBe('draft')
  })

  test('a collection with approval switched off publishes exactly as it always did', async () => {
    await seed(0)
    const updated = await updateEntry(
      env,
      site,
      'posts',
      'hello',
      { status: 'published' },
      'usr_author',
    )
    expect(updated.status).toBe('published')
  })
})

describe('a version forked from the live entry', () => {
  test('copies the entry when no data is given, and goes stale when the entry moves on', async () => {
    await seed(0)
    const version = await createEntryVersion(
      env,
      site,
      'posts',
      'hello',
      { title: 'Second take' },
      'usr_one',
    )
    expect(version.data.title).toBe('Hello')
    expect(version.stale).toBe(false)

    // Somebody else edits the live entry underneath it.
    await updateEntry(env, site, 'posts', 'hello', { data: { title: 'Moved on' } }, 'usr_author')

    const [reloaded] = await (await import('./entry-versions')).listEntryVersions(
      env,
      site,
      'posts',
      'hello',
    )
    expect(reloaded?.stale).toBe(true)
  })
})
