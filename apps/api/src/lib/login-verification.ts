import {
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_TTL_MINUTES,
  TRUSTED_DEVICE_TTL_DAYS,
  type TrustedDevice,
} from '@hedge/core'
import { and, eq, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { getDb } from '../db/client'
import {
  type LoginChallengeRow,
  loginChallenges,
  sessions,
  trustedDevices,
  type UserRow,
} from '../db/schema'
import { renderEmail } from '../email/render'
import { sendEmail } from '../email/send'
import type { AppEnv, Bindings } from '../env'
import { hmac, randomToken, timingSafeEqualString } from './crypto'
import { ApiError } from './errors'
import { newId } from './id'

/**
 * The second step of a sign-in from a browser this account has not been seen on.
 *
 * The threat this answers is a password that has leaked — reused, phished, or breached elsewhere.
 * Everything else in `auth.md` protects the credential; nothing until now noticed a correct one
 * arriving from somewhere it never had before. So a password alone stops being sufficient: it buys
 * a code mailed to the address on the account, and only that finishes the sign-in.
 *
 * Deliberately keyed on the *device* and not the IP address. A phone moves between cell towers and
 * wifi many times a day and each move is a new address; prompting on that would mail several codes
 * a day to every mobile user, and a check people are trained to click through is not a check.
 */

/** Name of the cookie carrying the opaque device id. Not a credential on its own — see below. */
const DEVICE_COOKIE = 'hedge_device'

const CODE_TTL_SECONDS = LOGIN_CODE_TTL_MINUTES * 60
const DEVICE_TTL_SECONDS = TRUSTED_DEVICE_TTL_DAYS * 24 * 60 * 60

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * A uniformly distributed decimal code.
 *
 * Rejection sampling rather than `% 10`: the byte range 0–255 does not divide into ten, so the
 * modulo would make 0–5 appear about 20% more often than 6–9 and shrink the space an attacker has
 * to walk. Cheap to do correctly, so it is done correctly.
 */
function generateCode(): string {
  const digits: string[] = []
  while (digits.length < LOGIN_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(LOGIN_CODE_LENGTH))
    for (const byte of bytes) {
      if (byte >= 250) continue
      digits.push(String(byte % 10))
      if (digits.length === LOGIN_CODE_LENGTH) break
    }
  }
  return digits.join('')
}

/** `re****@example.com` — enough to recognise the inbox, not enough to learn it. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const head = local.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(local.length - head.length, 1))}@${domain}`
}

/** A short description of a browser, for the account page and the "attempted from" line. */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device'

  const browser = /\bEdg\//.test(userAgent)
    ? 'Edge'
    : /\bOPR\//.test(userAgent)
      ? 'Opera'
      : /\bFirefox\//.test(userAgent)
        ? 'Firefox'
        : /\bChrome\//.test(userAgent)
          ? 'Chrome'
          : /\bSafari\//.test(userAgent)
            ? 'Safari'
            : 'Unknown browser'

  const platform = /\bWindows\b/.test(userAgent)
    ? 'Windows'
    : /\b(iPhone|iPad|iOS)\b/.test(userAgent)
      ? 'iOS'
      : /\bAndroid\b/.test(userAgent)
        ? 'Android'
        : /\bMac OS X\b/.test(userAgent)
          ? 'macOS'
          : /\bLinux\b/.test(userAgent)
            ? 'Linux'
            : 'Unknown platform'

  return `${browser} on ${platform}`
}

export function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? null
}

/**
 * Whether this browser has already been vouched for by this user.
 *
 * Reads the opaque id from the cookie and looks up its HMAC — the raw id is never stored, so a
 * dumped `trusted_devices` table yields nothing that can be presented back. An expired row is
 * treated as absent and swept, so trust lapses on its own rather than on a cron.
 */
export async function isTrustedDevice(c: Context<AppEnv>, userId: string): Promise<boolean> {
  const deviceId = getCookie(c, DEVICE_COOKIE)
  if (!deviceId) return false

  const db = getDb(c.env)
  const [row] = await db
    .select()
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.deviceHash, await hmac(c.env.AUTH_SECRET, deviceId)),
        eq(trustedDevices.userId, userId),
      ),
    )
    .limit(1)

  if (!row) return false

  if (row.expiresAt <= nowSeconds()) {
    await db.delete(trustedDevices).where(eq(trustedDevices.id, row.id))
    return false
  }

  // Sliding window: somebody who signs in every week is never asked again, while a browser left
  // alone for a month has to prove itself once more.
  await db
    .update(trustedDevices)
    .set({ lastUsedAt: new Date().toISOString(), expiresAt: nowSeconds() + DEVICE_TTL_SECONDS })
    .where(eq(trustedDevices.id, row.id))

  return true
}

/**
 * Remembers this browser and sets the cookie naming it.
 *
 * `httpOnly` so script on the page cannot read it, `sameSite: 'lax'` rather than `strict` because
 * an MCP client's authorization redirect arrives as a cross-site top-level navigation and `strict`
 * would withhold the cookie there — turning every OAuth sign-in into a fresh code. It is not a
 * session credential, so `lax` costs nothing: it names a device, and a password is still required.
 */
async function trustDevice(c: Context<AppEnv>, userId: string, userAgent: string | null) {
  const deviceId = randomToken(32)
  const expiresAt = nowSeconds() + DEVICE_TTL_SECONDS

  await getDb(c.env)
    .insert(trustedDevices)
    .values({
      id: newId('dev'),
      userId,
      deviceHash: await hmac(c.env.AUTH_SECRET, deviceId),
      label: describeDevice(userAgent),
      expiresAt,
    })

  setCookie(c, DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    secure: new URL(c.env.PUBLIC_URL).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: DEVICE_TTL_SECONDS,
  })
}

/**
 * Parks a verified sign-in behind a mailed code.
 *
 * The session Better Auth just created is real but unreachable: its cookies stay in the challenge
 * row instead of going to the browser. If the code is never entered, `discardChallenge` takes both
 * the row and that orphaned session away.
 */
export async function startLoginChallenge(
  c: Context<AppEnv>,
  user: UserRow,
  cookies: string[],
): Promise<{ challengeId: string; maskedEmail: string; expiresAt: string }> {
  const db = getDb(c.env)
  const userAgent = c.req.header('user-agent') ?? null
  const code = generateCode()
  const expiresAt = nowSeconds() + CODE_TTL_SECONDS

  // Only one challenge in flight per user: a second sign-in attempt invalidates the first, so a
  // code mailed to an inbox the attacker is also reading cannot be banked for later.
  await discardUserChallenges(c.env, user.id)

  const [row] = await db
    .insert(loginChallenges)
    .values({
      id: newId('lch'),
      userId: user.id,
      codeHash: await hmac(c.env.AUTH_SECRET, code),
      sessionCookies: cookies,
      sessionToken: sessionTokenFromCookies(cookies),
      userAgent,
      ipAddress: clientIp(c),
      expiresAt,
    })
    .returning()

  const device = describeDevice(userAgent)
  await sendEmail(
    c.env,
    await renderEmail(c.env, 'login_code', {
      to: user.email,
      name: user.name,
      // No link in this email by design, but `renderEmail` always has a `url` to work with — point
      // it at the sign-in screen so an operator's override that adds a button still lands somewhere
      // sensible rather than on `undefined`.
      url: `${c.env.PUBLIC_URL}/login`,
      code,
      device,
    }),
    { templateKey: 'login_code' },
  )

  return {
    challengeId: row!.id,
    maskedEmail: maskEmail(user.email),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}

/**
 * Checks a code and, if it is right, hands back the parked cookies for the caller to apply.
 *
 * Every failure mode ends the challenge rather than merely refusing the attempt, so there is no
 * state an attacker can sit on: a wrong code past the attempt ceiling, an expired row, and a
 * redeemed one all leave nothing behind.
 */
export async function completeLoginChallenge(
  c: Context<AppEnv>,
  challengeId: string,
  code: string,
  trust: boolean,
): Promise<{ userId: string; cookies: string[] }> {
  const db = getDb(c.env)

  const [row] = await db
    .select()
    .from(loginChallenges)
    .where(eq(loginChallenges.id, challengeId))
    .limit(1)

  // One message for "no such challenge", "expired" and "wrong code" alike. Distinguishing them
  // would confirm that a given challenge id — and so a given password — was good.
  const invalid = () => ApiError.unauthorized('That code is invalid or has expired')

  if (!row) throw invalid()

  if (row.expiresAt <= nowSeconds()) {
    await discardChallenge(c.env, row)
    throw invalid()
  }

  if (!timingSafeEqualString(row.codeHash, await hmac(c.env.AUTH_SECRET, code))) {
    const attempts = row.attempts + 1
    if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
      await discardChallenge(c.env, row)
      throw ApiError.unauthorized('Too many incorrect codes. Sign in again to get a new one.')
    }
    await db.update(loginChallenges).set({ attempts }).where(eq(loginChallenges.id, row.id))
    throw invalid()
  }

  // Redeemed: the row goes, but not the session it points at — that is the one being handed over.
  await db.delete(loginChallenges).where(eq(loginChallenges.id, row.id))

  if (trust) await trustDevice(c, row.userId, row.userAgent)

  return { userId: row.userId, cookies: row.sessionCookies }
}

/** Re-mails the code for a challenge still in flight, without disturbing its attempt count. */
export async function resendLoginCode(
  c: Context<AppEnv>,
  challengeId: string,
  user: UserRow,
): Promise<{ expiresAt: string }> {
  const db = getDb(c.env)

  const [row] = await db
    .select()
    .from(loginChallenges)
    .where(and(eq(loginChallenges.id, challengeId), eq(loginChallenges.userId, user.id)))
    .limit(1)

  if (!row || row.expiresAt <= nowSeconds()) {
    throw ApiError.unauthorized('That sign-in has expired. Start again.')
  }

  // A fresh code replaces the old one rather than adding a second working code to the same
  // challenge — the same reasoning `sendUserInvite` spends an outstanding invite for.
  const code = generateCode()
  const expiresAt = nowSeconds() + CODE_TTL_SECONDS

  await db
    .update(loginChallenges)
    .set({ codeHash: await hmac(c.env.AUTH_SECRET, code), expiresAt })
    .where(eq(loginChallenges.id, row.id))

  await sendEmail(
    c.env,
    await renderEmail(c.env, 'login_code', {
      to: user.email,
      name: user.name,
      url: `${c.env.PUBLIC_URL}/login`,
      code,
      device: describeDevice(row.userAgent),
    }),
    { templateKey: 'login_code' },
  )

  return { expiresAt: new Date(expiresAt * 1000).toISOString() }
}

/**
 * Better Auth's session cookie value is `<token>.<signature>`; the token half is the `sessions.token`
 * column. Pulled out so an abandoned challenge can delete the session it stranded — without it,
 * every unfinished sign-in would leave a live row in the user's "Active sessions" list.
 */
export function sessionTokenFromCookies(cookies: string[]): string | null {
  for (const cookie of cookies) {
    const [pair] = cookie.split(';')
    const index = pair?.indexOf('=') ?? -1
    if (index < 0 || !pair) continue
    if (!pair.slice(0, index).trim().endsWith('session_token')) continue
    const value = decodeURIComponent(pair.slice(index + 1))
    return value.split('.')[0] || null
  }
  return null
}

/** Drops a challenge and the session its parked cookies would have unlocked. */
async function discardChallenge(env: Bindings, row: LoginChallengeRow): Promise<void> {
  const db = getDb(env)
  await db.delete(loginChallenges).where(eq(loginChallenges.id, row.id))
  if (row.sessionToken) await db.delete(sessions).where(eq(sessions.token, row.sessionToken))
}

/** Spends every challenge a user has open. */
export async function discardUserChallenges(env: Bindings, userId: string): Promise<void> {
  const rows = await getDb(env)
    .select()
    .from(loginChallenges)
    .where(eq(loginChallenges.userId, userId))

  for (const row of rows) await discardChallenge(env, row)
}

/**
 * Sweeps challenges that lapsed without anyone returning to them. Called on the sign-in path rather
 * than from the cron: this table is written by an unauthenticated endpoint, so it must not depend
 * on a daily job to stay bounded — and the sign-in path is exactly where growth comes from.
 */
export async function pruneExpiredChallenges(env: Bindings): Promise<void> {
  const rows = await getDb(env)
    .select()
    .from(loginChallenges)
    .where(lt(loginChallenges.expiresAt, nowSeconds()))
    .limit(50)

  for (const row of rows) await discardChallenge(env, row)
}

/* ------------------------------------------------------------------ *
 * Trusted devices, as the account page manages them
 * ------------------------------------------------------------------ */

export async function listTrustedDevices(
  c: Context<AppEnv>,
  userId: string,
): Promise<TrustedDevice[]> {
  const deviceId = getCookie(c, DEVICE_COOKIE)
  const currentHash = deviceId ? await hmac(c.env.AUTH_SECRET, deviceId) : null

  const rows = await getDb(c.env)
    .select()
    .from(trustedDevices)
    .where(eq(trustedDevices.userId, userId))

  return rows
    .filter((row) => row.expiresAt > nowSeconds())
    .map((row) => ({
      id: row.id,
      label: row.label,
      current: currentHash !== null && row.deviceHash === currentHash,
      lastUsedAt: row.lastUsedAt,
      expiresAt: new Date(row.expiresAt * 1000).toISOString(),
      createdAt: row.createdAt,
    }))
}

export async function revokeTrustedDevice(
  env: Bindings,
  userId: string,
  id: string,
): Promise<void> {
  const [row] = await getDb(env)
    .delete(trustedDevices)
    .where(and(eq(trustedDevices.id, id), eq(trustedDevices.userId, userId)))
    .returning({ id: trustedDevices.id })

  if (!row) throw ApiError.notFound('Device')
}

/**
 * Forgets every device for a user, and clears the cookie on the browser asking.
 *
 * Called wherever the account's password changes: someone who has just decided their password was
 * compromised is telling us the devices vouched for under it are suspect too. Ending the sessions
 * without ending the trust would leave an attacker's browser able to sign in with the new password
 * and never see a code.
 */
export async function revokeAllTrustedDevices(c: Context<AppEnv>, userId: string): Promise<void> {
  await getDb(c.env).delete(trustedDevices).where(eq(trustedDevices.userId, userId))
  deleteCookie(c, DEVICE_COOKIE, { path: '/' })
}
