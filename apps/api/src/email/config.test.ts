import { describe, expect, test } from 'bun:test'
import type { EmailConfigRow, SiteRow } from '../db/schema'
import type { Bindings } from '../env'
import { resolveBrand, resolveSender, type SenderIdentity } from './config'

const env = {
  APP_NAME: 'Hedge',
  EMAIL_FROM: 'hedge@example.com',
  EMAIL_FROM_NAME: 'Hedge',
} as Bindings

const deployment = {
  fromEmail: 'cms@example.com',
  fromName: 'The CMS',
  replyTo: 'support@example.com',
} as EmailConfigRow

function site(over: Partial<SiteRow> = {}): SiteRow {
  return { name: 'The Blog', ...over } as SiteRow
}

function sender(over: Partial<SenderIdentity>): SenderIdentity {
  return { email: 'news@blog.example', name: null, replyTo: null, ...over }
}

describe('resolveSender', () => {
  test('falls back to the environment when nothing is configured', () => {
    expect(resolveSender(env, null, null)).toEqual({ email: 'hedge@example.com', name: 'Hedge' })
  })

  test('the deployment CMS config wins over the environment', () => {
    expect(resolveSender(env, deployment, null)).toEqual({
      email: 'cms@example.com',
      name: 'The CMS',
      replyTo: 'support@example.com',
    })
  })

  test('a chosen sender wins over the deployment config', () => {
    const resolved = resolveSender(
      env,
      deployment,
      sender({ email: 'members@blog.example', name: 'The Blog' }),
    )
    expect(resolved).toEqual({
      email: 'members@blog.example',
      name: 'The Blog',
      // The sender left reply-to null, so the deployment's is still what a reply goes to.
      replyTo: 'support@example.com',
    })
  })

  test('a sender field left null inherits on its own, not dragging the others with it', () => {
    // An address with no display name keeps the name below it.
    expect(resolveSender(env, null, sender({ email: 'members@blog.example', name: null }))).toEqual(
      {
        email: 'members@blog.example',
        name: 'Hedge',
      },
    )
  })

  test('operator email — no chosen sender — is the deployment/environment sender', () => {
    expect(resolveSender(env, null, null).email).toBe('hedge@example.com')
  })
})

describe('resolveBrand', () => {
  test('operator email is branded as the deployment', () => {
    expect(resolveBrand(env, null, null)).toBe('Hedge')
  })

  test('a site with no chosen sender is branded as the site, not as the CMS behind it', () => {
    // The #129 defect: a member of The Blog was invited to "Hedge". A site always has a name, so the
    // brand never reaches the deployment for a site email.
    expect(resolveBrand(env, site(), null)).toBe('The Blog')
  })

  test("the chosen sender's display name is the brand when it has one (#136)", () => {
    // A newsletter sent as a listed address named "Mark Cuban" reads as "Mark Cuban" in the body,
    // so the From line and the body agree.
    expect(resolveBrand(env, site(), sender({ name: 'Mark Cuban' }))).toBe('Mark Cuban')
  })

  test('a chosen sender with no name still brands as the site, never the CMS', () => {
    expect(resolveBrand(env, site(), sender({ name: null }))).toBe('The Blog')
  })
})
