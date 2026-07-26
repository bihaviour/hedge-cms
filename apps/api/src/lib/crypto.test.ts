import { describe, expect, test } from 'bun:test'
import { hashPassword, verifyPassword } from './crypto'

/** workerd's ceiling. Above it `deriveBits` throws, and every sign-in in the deployment 500s. */
const WORKERD_MAX_PBKDF2_ITERATIONS = 100_000

describe('password hashing', () => {
  test('stays within the iteration count workerd will run', async () => {
    const [, iterations] = (await hashPassword('a-perfectly-fine-password')).split('$')
    expect(Number(iterations)).toBeLessThanOrEqual(WORKERD_MAX_PBKDF2_ITERATIONS)
  })

  test('round-trips a password', async () => {
    const hash = await hashPassword('a-perfectly-fine-password')
    expect(await verifyPassword('a-perfectly-fine-password', hash)).toBe(true)
    expect(await verifyPassword('a-perfectly-fine-passworD', hash)).toBe(false)
  })

  test('fails a hash that needs more iterations than this runtime allows, rather than throwing', async () => {
    const stored = (await hashPassword('a-perfectly-fine-password')).replace(
      /^pbkdf2\$\d+\$/,
      'pbkdf2$210000$',
    )
    expect(await verifyPassword('a-perfectly-fine-password', stored)).toBe(false)
  })
})
