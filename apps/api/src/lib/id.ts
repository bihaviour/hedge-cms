const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * Lexicographically sortable, URL-safe id (Crockford base32 timestamp + randomness).
 * Sorting by id sorts by creation time, which keeps cursor pagination cheap on D1.
 */
export function newId(prefix?: string): string {
  const now = Date.now()
  let time = ''
  let remaining = now
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[remaining % 32]! + time
    remaining = Math.floor(remaining / 32)
  }

  const random = crypto.getRandomValues(new Uint8Array(10))
  let suffix = ''
  for (const byte of random) suffix += ALPHABET[byte % 32]!

  return prefix ? `${prefix}_${time}${suffix}` : `${time}${suffix}`
}
