import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMBER_TOKEN_FRAGMENT_KEY } from '@hedge/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { memberAccounts, memberSessions, memberSites, members, sites } from '../db/schema'
import type { Actor, AppEnv } from '../env'

/**
 * The two ways a reader is signed in without a Hedge password (#108), against a real SQLite built
 * from the committed migrations and the real member Better Auth instance.
 *
 * What is pinned here is what a type cannot hold. A minted session has to be a *session* — the same
 * row a password sign-in produces, honoured by `/me` and ended by logout — or the feature is a token
 * that looks right and unlocks nothing. And both paths have to refuse on the same grounds a sign-in
 * refuses, at the tenant boundary, *after* Better Auth has already said yes.
 */

/**
 * Only the database and the mail are stubbed. `lib/site` and `lib/auth` are the real ones — the
 * tenant is resolved from the database and the mint route's role and scope checks are the point —
 * which is why no suite in this directory may replace either of them: `mock.module` is process-wide
 * and every file's registrations are in place before any of them run.
 */
let db: ReturnType<typeof drizzle>

const realClient = await import('../db/client')
mock.module('../db/client', () => ({ ...realClient, getDb: () => db }))

/**
 * Every email that would have gone out, so a test can pull the sign-in link out of one. Only the
 * *send* is stubbed — the render above it is real, which is what lets a test read the brand the
 * message was composed under.
 */
let sent: {
  to: string
  templateKey: string | undefined
  text: string
  siteName: string | undefined
  url: string
}[] = []
mock.module('../email/send', () => ({
  sendEmail: async (
    _env: unknown,
    message: { to: string; subject: string; text: string },
    options?: { templateKey?: string; site?: { name: string } | null },
  ) => {
    sent.push({
      to: message.to,
      templateKey: options?.templateKey,
      text: message.text,
      siteName: options?.site?.name,
      url: /https?:\/\/\S+/.exec(message.text)?.[0] ?? '',
    })
  },
}))

const { memberAuth, memberSessionMint } = await import('./members')
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

/**
 * A fresh `env` per test, and that matters: the member auth instance is cached against this object
 * and captures the database when it is built, so reusing one would leave it pointing at the SQLite
 * of the previous test.
 */
let env: AppEnv['Bindings']

/** The key a site's own backend holds: it may mint a session and do nothing else. */
const mintingKey: Actor = {
  kind: 'api_key',
  via: 'api_key',
  id: 'key_1',
  role: 'admin',
  permissions: [],
  scopes: ['members:session'],
  siteId: 'site_1',
}

/**
 * The member routes wired the way `index.ts` wires them: actor, then site, then member — the order
 * is what lets a key be bound to its own site and a token be checked against that site's grant.
 */
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
  app.route('/api/v1/member-sessions', memberSessionMint)
  app.onError((error, c) => errorResponse(c, error))

  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://cms.example.com${path}`, init), env)
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Mints a session for `memberId` on the site the key was issued for. */
async function mint(memberId: string, actor: Actor = mintingKey) {
  const response = await server(actor)('/api/v1/member-sessions?site=blog', json({ memberId }))
  return { status: response.status, body: (await response.json()) as Record<string, never> }
}

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })
  sent = []

  env = {
    AUTH_SECRET: 'test-secret-not-a-real-one',
    PUBLIC_URL: 'https://cms.example.com',
    APP_NAME: 'Hedge',
    ENVIRONMENT: 'development',
  } as unknown as AppEnv['Bindings']

  await db.insert(sites).values([
    { id: 'site_1', slug: 'blog', name: 'Blog', domain: 'blog.example.com' },
    // Invite-only, and no domain: nowhere to redirect a reader to, which is its own case below.
    { id: 'site_2', slug: 'docs', name: 'Docs', allowMemberSignup: false },
  ])

  await db.insert(members).values([
    { id: 'mem_1', email: 'reader@example.com', name: 'Reader', emailVerified: true },
    // Added by an admin and never followed their link: no password, so `pending`.
    { id: 'mem_2', email: 'pending@example.com', name: 'Pending' },
    { id: 'mem_3', email: 'blocked@example.com', name: 'Blocked', emailVerified: true },
  ])

  await db.insert(memberSites).values([
    { siteId: 'site_1', memberId: 'mem_1' },
    { siteId: 'site_1', memberId: 'mem_2' },
    { siteId: 'site_1', memberId: 'mem_3', status: 'blocked' },
  ])
})

describe('minting a member session server to server', () => {
  test('answers what a login answers, and the token is a session', async () => {
    const minted = await mint('mem_1')

    expect(minted.status).toBe(201)
    const { token, expiresAt, member } = minted.body.data as unknown as {
      token: string
      expiresAt: string
      member: { id: string; siteId: string }
    }
    expect(token).toBeTruthy()
    expect(member).toMatchObject({ id: 'mem_1', siteId: 'site_1' })
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())

    const me = await server()('/api/v1/member/me?site=blog', {
      headers: { 'x-member-token': token },
    })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { data: { id: string } }).data.id).toBe('mem_1')
  })

  test('the session ends when the member signs out, like any other', async () => {
    const { token } = (await mint('mem_1')).body.data as unknown as { token: string }
    const call = server()

    expect(
      (
        await call('/api/v1/member/logout', {
          method: 'POST',
          headers: { 'x-member-token': token },
        })
      ).status,
    ).toBe(200)

    const me = await call('/api/v1/member/me?site=blog', { headers: { 'x-member-token': token } })
    expect(me.status).toBe(401)
  })

  test('the row is Better Auth’s own — the id prefix a sign-in would have produced', async () => {
    const { token } = (await mint('mem_1')).body.data as unknown as { token: string }

    const [row] = await db.select().from(memberSessions)
    expect(row?.token).toBe(token)
    expect(row?.id.startsWith('mss_')).toBe(true)
    expect(row?.userId).toBe('mem_1')
  })

  test('a member with no password is minted for — the point of the flow', async () => {
    const minted = await mint('mem_2')

    expect(minted.status).toBe(201)
    // Still no credential: minting is not a way to acquire one.
    expect(await db.select().from(memberAccounts)).toHaveLength(0)
  })

  test('refuses a blocked member, and leaves no session behind', async () => {
    const minted = await mint('mem_3')

    expect(minted.status).toBe(403)
    expect(await db.select().from(memberSessions)).toHaveLength(0)
  })

  test('refuses a member of another site when this one is invite-only', async () => {
    const response = await server({ ...mintingKey, siteId: 'site_2' })(
      '/api/v1/member-sessions?site=docs',
      json({ memberId: 'mem_1' }),
    )

    expect(response.status).toBe(403)
    expect(await db.select().from(memberSessions)).toHaveLength(0)
  })

  test('refuses an unknown member', async () => {
    expect((await mint('mem_nope')).status).toBe(404)
  })

  test('refuses an authoring key that has every other scope', async () => {
    const authoring: Actor = {
      ...mintingKey,
      role: 'admin',
      scopes: ['content:write', 'media:write', 'collections:write'],
    }

    const response = await server(authoring)(
      '/api/v1/member-sessions?site=blog',
      json({ memberId: 'mem_1' }),
    )
    expect(response.status).toBe(403)
  })

  test('refuses an expiresIn a caller might believe in', async () => {
    const response = await server(mintingKey)(
      '/api/v1/member-sessions?site=blog',
      json({ memberId: 'mem_1', expiresIn: 600 }),
    )
    expect(response.status).toBe(400)
  })
})

describe('signing in with a magic link', () => {
  /** Requests a link and returns the URL that was mailed. */
  async function requestLink(body: Record<string, unknown>, site = 'blog') {
    const response = await server()(`/api/v1/member/magic-link?site=${site}`, json(body))
    expect(response.status).toBe(200)
    return sent.at(-1)
  }

  test('is branded as the site the reader is signing in to, not as the CMS (#129)', async () => {
    const mail = await requestLink({ email: 'reader@example.com' })

    // `APP_NAME` here is 'Hedge'. A reader of blog.example.com has never heard of it, so the one
    // name that may appear is the site's — and the send is scoped to that site for the same reason.
    expect(mail?.text).toStartWith('Sign in to Blog')
    expect(mail?.text).not.toContain('Hedge')
    expect(mail?.siteName).toBe('Blog')
  })

  test('mails a link that signs the reader in and lands them on the site', async () => {
    const mail = await requestLink({ email: 'reader@example.com' })
    expect(mail?.templateKey).toBe('member_magic_link')

    const verify = await server()(
      new URL(mail?.url ?? '').pathname + new URL(mail?.url ?? '').search,
    )
    expect(verify.status).toBe(302)

    const landing = new URL(verify.headers.get('location') ?? '')
    expect(landing.origin).toBe('https://blog.example.com')

    // The token comes back in the fragment, which never reaches the website's server.
    const token = new URLSearchParams(landing.hash.slice(1)).get(MEMBER_TOKEN_FRAGMENT_KEY)
    expect(token).toBeTruthy()

    const me = await server()('/api/v1/member/me?site=blog', {
      headers: { 'x-member-token': token ?? '' },
    })
    expect(((await me.json()) as { data: { id: string } }).data.id).toBe('mem_1')
  })

  test('the link works once', async () => {
    const mail = await requestLink({ email: 'reader@example.com' })
    const path = new URL(mail?.url ?? '').pathname + new URL(mail?.url ?? '').search

    expect((await server()(path)).status).toBe(302)
    expect((await server()(path)).status).toBe(401)
  })

  test('says the same thing about an address that is nobody, and mails nothing', async () => {
    const response = await server()(
      '/api/v1/member/magic-link?site=blog',
      json({ email: 'stranger@example.com' }),
    )

    expect(response.status).toBe(200)
    expect(sent).toHaveLength(0)
  })

  test('a callbackURL off the site’s domain falls back to the site itself', async () => {
    const mail = await requestLink({
      email: 'reader@example.com',
      callbackURL: 'https://phishing.example/steal',
    })

    const verify = await server()(
      new URL(mail?.url ?? '').pathname + new URL(mail?.url ?? '').search,
    )
    expect(new URL(verify.headers.get('location') ?? '').origin).toBe('https://blog.example.com')
  })

  test('a redirect tampered with after the link was mailed is still refused', async () => {
    const mail = await requestLink({ email: 'reader@example.com' })
    const url = new URL(mail?.url ?? '')
    url.searchParams.set('redirect', 'https://phishing.example/steal')

    const verify = await server()(url.pathname + url.search)
    expect(new URL(verify.headers.get('location') ?? '').origin).toBe('https://blog.example.com')
  })

  test('refuses at the tenant boundary, and takes the session it had already minted', async () => {
    // `mem_1` reads the blog, and `docs` is invite-only — redeeming a link proves an address, not
    // a right to be here. Better Auth has already created a session by this point.
    const mail = await requestLink({ email: 'reader@example.com' }, 'docs')
    const verify = await server()(
      new URL(mail?.url ?? '').pathname + new URL(mail?.url ?? '').search,
    )

    expect(verify.status).toBe(403)
    expect(await db.select().from(memberSessions)).toHaveLength(0)
  })

  test('with no domain to land on, the session comes back as a login answers', async () => {
    await db.insert(memberSites).values({ siteId: 'site_2', memberId: 'mem_1' })

    const mail = await requestLink({ email: 'reader@example.com' }, 'docs')
    const verify = await server()(
      new URL(mail?.url ?? '').pathname + new URL(mail?.url ?? '').search,
    )

    expect(verify.status).toBe(200)
    const { data } = (await verify.json()) as { data: { token: string; member: { id: string } } }
    expect(data.member.id).toBe('mem_1')
    expect(data.token).toBeTruthy()
  })
})
