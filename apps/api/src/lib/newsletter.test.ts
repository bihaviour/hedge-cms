import { describe, expect, test } from 'bun:test'
import type { Bindings } from '../env'
import { unsubscribeToken, verifyUnsubscribeToken } from './newsletter'

const env = { AUTH_SECRET: 'test-secret-value' } as Bindings

describe('unsubscribe tokens', () => {
  test('a freshly minted token verifies', async () => {
    const token = await unsubscribeToken(env, 'subscriber', 'site_1', 'nsub_1')
    expect(await verifyUnsubscribeToken(env, 'subscriber', 'site_1', 'nsub_1', token)).toBe(true)
  })

  test('a token is bound to its kind, site and id', async () => {
    const token = await unsubscribeToken(env, 'subscriber', 'site_1', 'nsub_1')
    // Same token, any field changed → rejected.
    expect(await verifyUnsubscribeToken(env, 'member', 'site_1', 'nsub_1', token)).toBe(false)
    expect(await verifyUnsubscribeToken(env, 'subscriber', 'site_2', 'nsub_1', token)).toBe(false)
    expect(await verifyUnsubscribeToken(env, 'subscriber', 'site_1', 'nsub_2', token)).toBe(false)
  })

  test('a tampered token is rejected', async () => {
    const token = await unsubscribeToken(env, 'subscriber', 'site_1', 'nsub_1')
    expect(await verifyUnsubscribeToken(env, 'subscriber', 'site_1', 'nsub_1', `${token}x`)).toBe(
      false,
    )
  })
})
