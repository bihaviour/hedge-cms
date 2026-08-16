import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { mcpClientGrants, oauthAccessTokens, oauthApplications, users } from '../db/schema'
import type { Actor, AppEnv } from '../env'

/**
 * Narrowing a connected MCP client's destructive grant (#149), against a real SQLite built from the
 * committed migrations.
 *
 * Two claims carry the feature and neither is visible in a type. **It is one-way** — the same route
 * that takes deletes away refuses to hand them back, because widening a live token is a power its
 * approval never described, and the honest form of that is a fresh consent. And **it is the acting
 * user's own grant**: a grant is per (user, client), so an operator narrowing somebody else's would
 * be an authorization change made by the one person who did not approve it.
 */

let db: ReturnType<typeof drizzle>

const realClient = await import('../db/client')
mock.module('../db/client', () => ({ ...realClient, getDb: () => db }))

const { default: auth } = await import('./auth')
const { errorResponse } = await import('../lib/errors')
const { destructiveGrantFor } = await import('../lib/mcp-grants')

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

const env = { PUBLIC_URL: 'https://cms.example.com' } as unknown as AppEnv['Bindings']

/** A signed-in operator. `requireUserActor` takes nothing else — not a key, not a delegated client. */
const operator = (id: string): Actor => ({
  kind: 'user',
  via: 'session',
  id,
  role: 'admin',
  permissions: [],
  scopes: [],
  siteId: null,
})

function server(actor: Actor | null) {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test')
    c.set('actor', actor)
    await next()
  })
  app.route('/api/v1/auth', auth)
  app.onError((error, c) => errorResponse(c, error))

  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://cms.example.com${path}`, init), env)
}

/** `PATCH /oauth/clients/:clientId` — the narrowing the account page drives. */
async function narrow(actor: Actor | null, clientId: string, destructive = false) {
  const response = await server(actor)(`/api/v1/auth/oauth/clients/${clientId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destructive }),
  })

  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as { error?: { message: string } } | null,
  }
}

const day = 24 * 60 * 60 * 1000

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })

  await db.insert(users).values([
    { id: 'usr_1', email: 'a@example.com', name: 'A', role: 'admin' },
    { id: 'usr_2', email: 'b@example.com', name: 'B', role: 'admin' },
  ])

  await db.insert(oauthApplications).values({
    id: 'app_1',
    name: 'Some Agent',
    clientId: 'client_a',
    redirectUrls: 'https://agent.example.com/callback',
    type: 'web',
  })

  // Both operators approved the same client, which is the case the ownership rule is about.
  await db.insert(oauthAccessTokens).values(
    ['usr_1', 'usr_2'].map((userId, index) => ({
      id: `tok_${index}`,
      accessToken: `access_${index}`,
      refreshToken: `refresh_${index}`,
      accessTokenExpiresAt: new Date(Date.now() + day),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * day),
      clientId: 'client_a',
      userId,
      scopes: 'entries:read entries:write',
    })),
  )
})

describe('PATCH /auth/oauth/clients/:clientId', () => {
  test('takes deletes away without touching the tokens', async () => {
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(true)

    const { status } = await narrow(operator('usr_1'), 'client_a')

    expect(status).toBe(204)
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(false)
    // The point of the whole issue: the client keeps working, it just stops being able to delete.
    // The grant is read per request at the MCP endpoint, so nothing had to be reissued.
    expect(await db.select().from(oauthAccessTokens)).toHaveLength(2)
  })

  test('refuses to hand deletes back', async () => {
    await narrow(operator('usr_1'), 'client_a')

    const { status, body } = await narrow(operator('usr_1'), 'client_a', true)

    // Widening is immediate in exactly the way narrowing is, and that is the problem: a token
    // issued under "no deletes" would silently gain them, with no consent screen behind it.
    expect(status).toBe(400)
    expect(body?.error?.message).toContain('revoke')
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(false)
  })

  test('one operator cannot narrow another operator’s grant', async () => {
    await narrow(operator('usr_2'), 'client_a')

    // A grant is per (user, client). The row written names usr_2 and nobody else, so usr_1 — who
    // approved the same client — is unaffected and their agent keeps deleting.
    expect(await destructiveGrantFor(env, 'usr_2', 'client_a')).toBe(false)
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(true)

    const rows = await db
      .select()
      .from(mcpClientGrants)
      .where(and(eq(mcpClientGrants.clientId, 'client_a'), eq(mcpClientGrants.userId, 'usr_1')))
    expect(rows).toHaveLength(0)
  })

  test('a client this operator never approved is not there to narrow', async () => {
    // Without this the route would let any signed-in operator write grant rows for client ids they
    // invented — the table is small because it only ever records a decision somebody made.
    const { status } = await narrow(operator('usr_1'), 'client_unknown')

    expect(status).toBe(404)
    expect(await db.select().from(mcpClientGrants)).toHaveLength(0)
  })

  test('a machine cannot narrow anything, because it cannot reach the route', async () => {
    const key: Actor = {
      kind: 'api_key',
      via: 'api_key',
      id: 'key_1',
      role: 'admin',
      permissions: [],
      scopes: ['collections:write'],
      siteId: 'site_1',
    }

    expect((await narrow(key, 'client_a')).status).toBe(403)
    expect((await narrow(null, 'client_a')).status).toBe(401)
    expect(await destructiveGrantFor(env, 'usr_1', 'client_a')).toBe(true)
  })
})
