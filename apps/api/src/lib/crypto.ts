/**
 * Password and token primitives built on Web Crypto only — no native deps, so it runs
 * unchanged in workerd. PBKDF2-SHA256 is the strongest KDF available in the Workers runtime.
 */

/**
 * workerd refuses `deriveBits` above 100,000 PBKDF2 iterations — the ceiling, not a preference:
 * asking for more throws `NotSupportedError` instead of running slower. Every password write and
 * every sign-in goes through here, so a higher number does not weaken hashes, it takes the whole
 * deployment down with a 500 on `/auth/setup` and `/auth/login`. Don't raise it.
 */
const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256

const encoder = new TextEncoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  )
  return new Uint8Array(bits)
}

/** Returns a self-describing string: `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const derived = await pbkdf2(password, salt)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2' || !iterations || !salt || !hash) return false

  // A hash written by a runtime with a higher ceiling than this one cannot be recomputed here, and
  // `deriveBits` would throw rather than return — which surfaces as a 500 on sign-in. Say so in the
  // log and fail the comparison, so the account is recoverable by a password reset.
  if (Number(iterations) > PBKDF2_ITERATIONS) {
    console.error(
      `password hash needs ${iterations} PBKDF2 iterations, above this runtime's ${PBKDF2_ITERATIONS} — the user has to reset it`,
    )
    return false
  }

  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromBase64Url(salt) as BufferSource,
      iterations: Number(iterations),
      hash: 'SHA-256',
    },
    key,
    KEY_BITS,
  )
  return timingSafeEqual(new Uint8Array(bits), fromBase64Url(hash))
}

/**
 * Keyed hash for values we look up by equality (session ids, API keys, invite tokens).
 * Keyed so a leaked database alone cannot be brute-forced offline.
 */
export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return toBase64Url(new Uint8Array(signature))
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b))
}
