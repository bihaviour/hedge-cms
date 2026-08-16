import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { memberAccounts, memberSites, members, sites } from '../db/schema'
import type { Actor, AppEnv } from '../env'

/**
 * What the member routes answer when Better Auth refuses (#164), against a real SQLite built from
 * the committed migrations and the real member Better Auth instance.
 *
 * #131 established that a refusal has to be translated, because `app.onError` recognises only
 * `ApiError` and everything else is a `500`. What this file pins is the case that argument does not
 * cover: three of these routes answer the same thing for a member and for a stranger *on purpose*,
 * so a translated status would replace the crash with a tidier way to ask which addresses are
 * members. The assertions are therefore equality between two answers rather than a status code —
 * a status is a thing to look up, an oracle is a thing to compare.
 *
 * The mailer is turned off mid-test in several of these, and that is the point rather than
 * housekeeping: it is the one failure a caller can provoke from outside, and it is where the leak
 * actually was.
 */

let db: ReturnType<typeof drizzle>

const realClient = await import('../db/client')
mock.module('../db/client', () => ({ ...realClient, getDb: () => db }))

/** Every email that went out, and a switch to break the mailer with. */
let sent: string[] = []
let mailFails = false
mock.module('../email/send', () => ({
  sendEmail: async (_env: unknown, message: { to: string }) => {
    if (mailFails) throw new Error('the mail provider is down')
    sent.push(message.to)
  },
}))

const { memberAuth, default: memberAdmin } = await import('./members')
const { errorResponse } = await import('../lib/errors')
const { resolveSite } = await import('../lib/site')
const { resolveMember } = await import('../lib/member-auth')

const MIGRATIONS = join(import.meta.dir, '../../migrations')

function migrate(sqlite: Database) {
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(join(MIGRATIONS, name), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
}

let env: AppEnv['Bindings']

/** An operator with every site power, for the admin-facing half. */
const admin: Actor = {
  kind: 'user',
  via: 'session',
  id: 'usr_1',
  role: 'owner',
  permissions: ['sites:access_all'],
  scopes: [],
  siteId: null,
}

function server(actor: Actor | null = null) {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test')
    await next()
  })
  app.use('/api/*', async (c, next) => {
    c.set('actor', actor)
    await next()
  })
  app.use('/api/*', resolveSite)
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/v1/member/')) return resolveMember(c, next)
    c.set('member', null)
    await next()
  })
  app.route('/api/v1/member', memberAuth)
  app.route('/api/v1/members', memberAdmin)
  app.onError((error, c) => errorResponse(c, error))

  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://cms.example.com${path}`, init), env)
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Status and raw body, which is what "answers the same" has to mean to be worth asserting. */
async function answer(response: Response) {
  return { status: response.status, body: await response.text() }
}

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })
  sent = []
  mailFails = false

  env = {
    AUTH_SECRET: 'test-secret-not-a-real-one',
    PUBLIC_URL: 'https://cms.example.com',
    APP_NAME: 'Hedge',
    ENVIRONMENT: 'development',
  } as unknown as AppEnv['Bindings']

  await db.insert(sites).values([{ id: 'site_1', slug: 'blog', name: 'Blog' }])
  await db
    .insert(members)
    .values([{ id: 'mem_1', email: 'reader@example.com', name: 'Reader', emailVerified: false }])
  await db.insert(memberSites).values([{ siteId: 'site_1', memberId: 'mem_1' }])
})

/**
 * The two routes whose comments promise an answer that does not vary with the address. Each is
 * asserted twice — once with the mail going out, once with it failing — because the send is the
 * only half of either route a member has that a stranger does not.
 */
describe('the routes that must answer the same for anybody', () => {
  const oracle = (path: string) => async (mailer: 'up' | 'down') => {
    mailFails = mailer === 'down'
    const call = server()

    const member = await answer(await call(path, json({ email: 'reader@example.com' })))
    const stranger = await answer(await call(path, json({ email: 'stranger@example.com' })))

    expect(member).toEqual(stranger)
    expect(member.status).toBe(200)
  }

  const forgotPassword = oracle('/api/v1/member/forgot-password?site=blog')
  const sendVerification = oracle('/api/v1/member/send-verification-email?site=blog')

  test('forgot-password says nothing about who is a member', async () => {
    await forgotPassword('up')
  })

  test('forgot-password says nothing about who is a member, with the mailer down', async () => {
    await forgotPassword('down')
  })

  test('send-verification-email says nothing about who is a member', async () => {
    await sendVerification('up')
  })

  /**
   * The one that reproduced. Better Auth absorbs a failed send on the reset path but lets one
   * escape here as a plain `Error`, so a member's address answered `500` while a stranger's — for
   * whom no mail is attempted at all — answered `200`.
   */
  test('send-verification-email says nothing about who is a member, with the mailer down', async () => {
    await sendVerification('down')
  })

  test('a stranger is still mailed nothing', async () => {
    await server()(
      '/api/v1/member/send-verification-email?site=blog',
      json({ email: 'stranger@example.com' }),
    )
    expect(sent).toHaveLength(0)
  })
})

describe('logging out', () => {
  test('a token that is nobody’s answers what presenting none answers', async () => {
    const call = server()

    const none = await answer(await call('/api/v1/member/logout', { method: 'POST' }))
    const invented = await answer(
      await call('/api/v1/member/logout', {
        method: 'POST',
        headers: { 'x-member-token': 'mss_not_a_real_token' },
      }),
    )

    expect(invented).toEqual(none)
    expect(invented.status).toBe(200)
  })
})

describe('registering', () => {
  /**
   * The read that decides "this address is new" and the write that acts on it are not one
   * transaction, so two registrations in flight for one address both pass the check and Better Auth
   * refuses the second. Its `APIError` used to reach `app.onError` unrecognised, which made the
   * lost race a `500` where the very same fact — that address is taken — is a `409` when the
   * pre-check catches it. The assertion is that the two agree, not merely that neither crashes.
   */
  test('a registration that loses a race is refused the way a duplicate is', async () => {
    const call = server()
    const body = { email: 'racer@example.com', name: 'Racer', password: 'correct-horse-battery' }

    const register = async () => answer(await call('/api/v1/member/register?site=blog', json(body)))
    const [first, second] = await Promise.all([register(), register()])

    const [won, lost] = first.status === 201 ? [first, second] : [second, first]
    expect(won.status).toBe(201)
    expect(lost.status).toBe(409)

    // And it is the same refusal the deterministic path gives, once the row is committed.
    const afterwards = await answer(await call('/api/v1/member/register?site=blog', json(body)))
    expect(afterwards).toEqual(lost)

    // One identity, one credential — the loser wrote nothing.
    expect(
      await db.select().from(members).where(eq(members.email, 'racer@example.com')),
    ).toHaveLength(1)
    expect(await db.select().from(memberAccounts)).toHaveLength(1)
  })
})

describe('inviting a member', () => {
  /**
   * The other side of the same coin: here the caller is an admin whose grant row is already
   * written, so a failure is theirs to see. Better Auth absorbs a failed send on this path, which
   * is why the invite still reports success — what the guard changes is that a refusal Better Auth
   * *does* make arrives as the status it chose rather than as a crash.
   */
  test('adding a member survives a mailer that is down', async () => {
    mailFails = true

    const response = await server(admin)(
      '/api/v1/members?site=blog',
      json({ email: 'invited@example.com', name: 'Invited' }),
    )

    expect(response.status).toBe(201)
    expect(((await response.json()) as { data: { pending: boolean } }).data.pending).toBe(true)
  })
})
