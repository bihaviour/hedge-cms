import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_CODE_MAX_ATTEMPTS } from '@hedge/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { loginChallenges, sessions, trustedDevices, users } from '../db/schema'
import type { AppEnv } from '../env'

/**
 * The step-up check against a real SQLite, built from the committed migrations.
 *
 * What is pinned here is the part a type cannot hold: that a challenge is *spent* by every way of
 * failing it rather than merely refused, that trust is scoped to one user, and that a sign-in
 * abandoned mid-code does not leave a usable session behind. Each of those is a way this feature
 * could look like it works while being worth nothing.
 */

let db: ReturnType<typeof drizzle>

mock.module('../db/client', () => ({ getDb: () => db }))

/** Captures what would have been mailed, so a test can read the code out of it. */
let sent: { to: string; code: string }[] = []
/** When set, the send rejects — standing in for a provider that refuses the message. */
let sendFailure: Error | null = null
mock.module('../email/send', () => ({
  sendEmail: async (_env: unknown, message: { to: string; text: string }) => {
    if (sendFailure) throw sendFailure
    // The default template puts the code in the body; pull the first 6-digit run out of the text.
    sent.push({ to: message.to, code: /\d{6}/.exec(message.text)?.[0] ?? '' })
  },
}))

const {
  completeLoginChallenge,
  describeDevice,
  isTrustedDevice,
  listTrustedDevices,
  maskEmail,
  pruneExpiredChallenges,
  revokeAllTrustedDevices,
  resendLoginCode,
  revokeTrustedDevice,
  sessionTokenFromCookies,
  startLoginChallenge,
} = await import('./login-verification')

const MIGRATIONS = join(import.meta.dir, '../../migrations')

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

const env = {
  AUTH_SECRET: 'test-secret-not-a-real-one',
  PUBLIC_URL: 'https://cms.example.com',
  APP_NAME: 'Hedge',
} as unknown as AppEnv['Bindings']

const user = {
  id: 'usr_1',
  email: 'reza@example.com',
  name: 'Reza',
  role: 'owner' as const,
  emailVerified: true,
  image: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
}

const other = { ...user, id: 'usr_2', email: 'other@example.com', name: 'Other' }

/** The `Set-Cookie` values Better Auth would have produced for a fresh session. */
const SESSION_COOKIES = ['better-auth.session_token=tok_abc.sig9; Path=/; HttpOnly; SameSite=Lax']

/**
 * Runs `fn` inside a genuine Hono context, so the cookie helpers read and write real headers rather
 * than a stub that could agree with a bug.
 */
async function withContext<T>(
  fn: (c: Context<AppEnv>) => Promise<T>,
  init: { cookie?: string; userAgent?: string } = {},
): Promise<{ result: T; setCookies: string[] }> {
  const app = new Hono<AppEnv>()
  let result!: T
  let failure: unknown = null

  app.all('*', async (c) => {
    try {
      result = await fn(c)
    } catch (error) {
      failure = error
    }
    return c.body(null, 204)
  })

  const headers = new Headers()
  if (init.cookie) headers.set('cookie', init.cookie)
  headers.set('user-agent', init.userAgent ?? 'Mozilla/5.0 (Macintosh; Mac OS X) Chrome/120.0')

  const response = await app.fetch(new Request('https://cms.example.com/', { headers }), env)
  if (failure) throw failure
  return { result, setCookies: response.headers.getSetCookie() }
}

/** Pulls the device cookie's value out of a `Set-Cookie` list, as a browser would store it. */
function deviceCookie(setCookies: string[]): string | null {
  for (const cookie of setCookies) {
    const [pair = ''] = cookie.split(';')
    const [name, ...rest] = pair.split('=')
    if (name?.trim() === 'hedge_device') return `hedge_device=${rest.join('=')}`
  }
  return null
}

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite, { casing: 'snake_case' })
  sent = []
  sendFailure = null

  await db.insert(users).values([user, other])
  // The session those parked cookies address. Its presence is what lets the orphan tests mean
  // something: a discarded challenge has to take it with it.
  await db.insert(sessions).values({
    id: 'ses_1',
    userId: user.id,
    token: 'tok_abc',
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  })
})

/** Starts a challenge and hands back its id and the code that was mailed. */
async function start() {
  const { result } = await withContext((c) => startLoginChallenge(c, user, SESSION_COOKIES))
  return { challengeId: result.challengeId, code: sent.at(-1)!.code }
}

describe('starting a challenge', () => {
  test('mails a code and parks the session rather than handing it over', async () => {
    const { challengeId, code } = await start()

    expect(code).toMatch(/^\d{6}$/)
    expect(sent[0]!.to).toBe('reza@example.com')

    const [row] = await db.select().from(loginChallenges)
    expect(row!.id).toBe(challengeId)
    // The code is never at rest in the clear — only its HMAC.
    expect(row!.codeHash).not.toContain(code)
    expect(row!.sessionCookies).toEqual(SESSION_COOKIES)
    expect(row!.sessionToken).toBe('tok_abc')
  })

  /**
   * The row and the parked session both exist before the send is attempted, so a provider that
   * refuses must take them with it. Letting the error escape instead left the pair behind *and*
   * reached the browser as a bare 500 before `challengeId` was returned — so the code screen never
   * rendered and a deployment with no trusted device could not sign in at all. Issue #117.
   */
  test('a refused email spends the challenge and the session it stranded', async () => {
    sendFailure = new Error('destination address is not a verified address')

    await expect(
      withContext((c) => startLoginChallenge(c, user, SESSION_COOKIES)),
    ).rejects.toMatchObject({ code: 'email_delivery_failed' })

    expect(await db.select().from(loginChallenges)).toHaveLength(0)
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  test('masks the address it reports back, so a wrong password learns nothing', async () => {
    const { result } = await withContext((c) => startLoginChallenge(c, user, SESSION_COOKIES))
    expect(result.maskedEmail).toBe('re**@example.com')
    expect(result.maskedEmail).not.toContain('reza@')
  })

  test('a second attempt invalidates the first, so an old code cannot be banked', async () => {
    const first = await start()
    const second = await start()

    const rows = await db.select().from(loginChallenges)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(second.challengeId)

    await expect(
      withContext((c) => completeLoginChallenge(c, first.challengeId, first.code, false)),
    ).rejects.toThrow(/invalid or has expired/)
  })
})

describe('completing a challenge', () => {
  test('a correct code hands back the parked cookies', async () => {
    const { challengeId, code } = await start()
    const { result } = await withContext((c) => completeLoginChallenge(c, challengeId, code, false))

    expect(result.userId).toBe(user.id)
    expect(result.cookies).toEqual(SESSION_COOKIES)
    // Redeemed challenges leave nothing behind…
    expect(await db.select().from(loginChallenges)).toHaveLength(0)
    // …but the session they were holding is the one being handed over, so it survives.
    expect(await db.select().from(sessions)).toHaveLength(1)
  })

  test('does not trust the browser unless asked to', async () => {
    const { challengeId, code } = await start()
    const { setCookies } = await withContext((c) =>
      completeLoginChallenge(c, challengeId, code, false),
    )

    expect(deviceCookie(setCookies)).toBeNull()
    expect(await db.select().from(trustedDevices)).toHaveLength(0)
  })

  test('trusting the browser records it and sets an httpOnly cookie', async () => {
    const { challengeId, code } = await start()
    const { setCookies } = await withContext((c) =>
      completeLoginChallenge(c, challengeId, code, true),
    )

    const cookie = setCookies.find((value) => value.startsWith('hedge_device='))
    expect(cookie).toBeDefined()
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')

    const [row] = await db.select().from(trustedDevices)
    expect(row!.userId).toBe(user.id)
    expect(row!.label).toBe('Chrome on macOS')
    // Only the HMAC is stored, so a dumped table yields nothing presentable.
    expect(cookie).not.toContain(row!.deviceHash)
  })

  test('a wrong code is refused and counted', async () => {
    const { challengeId } = await start()

    await expect(
      withContext((c) => completeLoginChallenge(c, challengeId, '000000', false)),
    ).rejects.toThrow(/invalid or has expired/)

    const [row] = await db.select().from(loginChallenges)
    expect(row!.attempts).toBe(1)
  })

  test('the attempt ceiling spends the challenge and the session it held', async () => {
    const { challengeId, code } = await start()

    for (let attempt = 0; attempt < LOGIN_CODE_MAX_ATTEMPTS; attempt++) {
      await expect(
        withContext((c) => completeLoginChallenge(c, challengeId, '000000', false)),
      ).rejects.toThrow()
    }

    // Gone, not merely refused — so the right code is worth nothing now either.
    expect(await db.select().from(loginChallenges)).toHaveLength(0)
    expect(await db.select().from(sessions)).toHaveLength(0)

    await expect(
      withContext((c) => completeLoginChallenge(c, challengeId, code, false)),
    ).rejects.toThrow(/invalid or has expired/)
  })

  test('an expired challenge is refused and takes its orphaned session with it', async () => {
    const { challengeId, code } = await start()
    await db.update(loginChallenges).set({ expiresAt: 1 })

    await expect(
      withContext((c) => completeLoginChallenge(c, challengeId, code, false)),
    ).rejects.toThrow(/invalid or has expired/)

    expect(await db.select().from(loginChallenges)).toHaveLength(0)
    // The whole point of parking the cookies: an unfinished sign-in leaves no live session.
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  test('pruning sweeps lapsed challenges and their sessions', async () => {
    await start()
    await db.update(loginChallenges).set({ expiresAt: 1 })

    await pruneExpiredChallenges(env)

    expect(await db.select().from(loginChallenges)).toHaveLength(0)
    expect(await db.select().from(sessions)).toHaveLength(0)
  })
})

describe('device trust', () => {
  /** Trusts the current browser and returns the cookie a browser would send back. */
  async function trust() {
    const { challengeId, code } = await start()
    const { setCookies } = await withContext((c) =>
      completeLoginChallenge(c, challengeId, code, true),
    )
    return deviceCookie(setCookies)!
  }

  test('a trusted browser skips the code', async () => {
    const cookie = await trust()
    const { result } = await withContext((c) => isTrustedDevice(c, user.id), { cookie })
    expect(result).toBe(true)
  })

  test('no cookie is not trusted', async () => {
    const { result } = await withContext((c) => isTrustedDevice(c, user.id))
    expect(result).toBe(false)
  })

  test('a made-up cookie is not trusted', async () => {
    await trust()
    const { result } = await withContext((c) => isTrustedDevice(c, user.id), {
      cookie: 'hedge_device=not-a-real-device-id',
    })
    expect(result).toBe(false)
  })

  test("one user's trusted browser is not trusted for another user", async () => {
    const cookie = await trust()
    const { result } = await withContext((c) => isTrustedDevice(c, other.id), { cookie })
    expect(result).toBe(false)
  })

  test('trust lapses on its own once expired', async () => {
    const cookie = await trust()
    await db.update(trustedDevices).set({ expiresAt: 1 })

    const { result } = await withContext((c) => isTrustedDevice(c, user.id), { cookie })
    expect(result).toBe(false)
    // …and the dead row is swept rather than left to accumulate.
    expect(await db.select().from(trustedDevices)).toHaveLength(0)
  })

  test('using a trusted browser extends it', async () => {
    const cookie = await trust()
    const [before] = await db.select().from(trustedDevices)
    await db.update(trustedDevices).set({ expiresAt: before!.expiresAt - 1000 })

    await withContext((c) => isTrustedDevice(c, user.id), { cookie })

    const [after] = await db.select().from(trustedDevices)
    expect(after!.expiresAt).toBeGreaterThan(before!.expiresAt - 1000)
  })

  test('listing marks the browser making the request', async () => {
    const cookie = await trust()
    const { result } = await withContext((c) => listTrustedDevices(c, user.id), { cookie })

    expect(result).toHaveLength(1)
    expect(result[0]!.current).toBe(true)
    expect(result[0]!.label).toBe('Chrome on macOS')
  })

  test("revoking is scoped to the owner — another user's id does not match", async () => {
    await trust()
    const [row] = await db.select().from(trustedDevices)

    await expect(revokeTrustedDevice(env, other.id, row!.id)).rejects.toThrow(/not found/i)
    expect(await db.select().from(trustedDevices)).toHaveLength(1)

    await revokeTrustedDevice(env, user.id, row!.id)
    expect(await db.select().from(trustedDevices)).toHaveLength(0)
  })

  test('revoking all forgets every device and clears the cookie', async () => {
    const cookie = await trust()
    const { setCookies } = await withContext((c) => revokeAllTrustedDevices(c, user.id), { cookie })

    expect(await db.select().from(trustedDevices)).toHaveLength(0)
    expect(setCookies.some((value) => value.startsWith('hedge_device=;'))).toBe(true)
  })
})

describe('helpers', () => {
  test('maskEmail keeps the domain and two characters', () => {
    expect(maskEmail('reza@example.com')).toBe('re**@example.com')
    // A one-character local part still gets a mask rather than being shown whole.
    expect(maskEmail('a@example.com')).toBe('a*@example.com')
  })

  test('describeDevice names the browser and platform, and survives a missing agent', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Firefox/121.0')).toBe('Firefox on Windows')
    // Edge and Chrome both carry "Chrome/" — the more specific token has to win.
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120')).toBe(
      'Edge on Windows',
    )
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')).toBe(
      'Safari on iOS',
    )
    expect(describeDevice(null)).toBe('Unknown device')
  })

  test('sessionTokenFromCookies reads the token half of the session cookie', () => {
    expect(sessionTokenFromCookies(SESSION_COOKIES)).toBe('tok_abc')
    expect(sessionTokenFromCookies(['other=value; Path=/'])).toBeNull()
    expect(sessionTokenFromCookies([])).toBeNull()
  })
})

describe('resending a code', () => {
  test('replaces the old code rather than leaving two that work', async () => {
    const { challengeId, code } = await start()
    await withContext((c) => resendLoginCode(c, challengeId, user))

    const fresh = sent.at(-1)!.code
    expect(fresh).not.toBe(code)

    // The old code is dead: only the new one matches the stored hash.
    await expect(
      withContext((c) => completeLoginChallenge(c, challengeId, code, false)),
    ).rejects.toThrow()
  })

  /**
   * The rotation lands before the send, so a refused email leaves a challenge whose only working
   * code was never delivered — a screen waiting for mail that is not coming. Spending it is what
   * every other failure in this file does. Issue #117.
   */
  test('a refused email spends the challenge rather than bricking it', async () => {
    const { challengeId } = await start()
    sendFailure = new Error('destination address is not a verified address')

    await expect(withContext((c) => resendLoginCode(c, challengeId, user))).rejects.toMatchObject({
      code: 'email_delivery_failed',
    })

    expect(await db.select().from(loginChallenges)).toHaveLength(0)
    expect(await db.select().from(sessions)).toHaveLength(0)
  })
})
