import { describe, expect, test } from 'bun:test'
import type { EmailConfigRow, SiteRow } from '../db/schema'
import type { Bindings } from '../env'
import { resolveBrand, resolveSender } from './config'

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

function site(sender: Partial<SiteRow>): SiteRow {
  return {
    name: 'The Blog',
    emailFrom: null,
    emailFromName: null,
    emailReplyTo: null,
    ...sender,
  } as SiteRow
}

describe('resolveSender', () => {
  test('falls back to the environment when nothing is configured', () => {
    expect(resolveSender(env, null, null)).toEqual({ email: 'hedge@example.com', name: 'Hedge' })
  })

  test('the deployment config wins over the environment', () => {
    expect(resolveSender(env, deployment, null)).toEqual({
      email: 'cms@example.com',
      name: 'The CMS',
      replyTo: 'support@example.com',
    })
  })

  test("a site's override wins over the deployment config", () => {
    const sender = resolveSender(
      env,
      deployment,
      site({ emailFrom: 'news@blog.example', emailFromName: 'The Blog' }),
    )
    expect(sender).toEqual({
      email: 'news@blog.example',
      name: 'The Blog',
      // Not overridden by the site, so the deployment's is still what a reply goes to.
      replyTo: 'support@example.com',
    })
  })

  test('an unset field on a site inherits on its own, rather than dragging the others with it', () => {
    expect(resolveSender(env, null, site({ emailFromName: 'The Blog' }))).toEqual({
      email: 'hedge@example.com',
      name: 'The Blog',
    })
  })

  test('deployment email ignores every site override — no site is passed for it', () => {
    // What an operator invite does: the site resolved on the request must not relabel it.
    expect(resolveSender(env, null, null).email).toBe('hedge@example.com')
  })
})

describe('resolveBrand', () => {
  test('deployment email is branded as the deployment', () => {
    expect(resolveBrand(env, null)).toBe('Hedge')
  })

  test("a site's email is branded as the site, not as the CMS behind it", () => {
    // The defect in #129: a member of The Blog was invited to "Hedge" because APP_NAME was the only
    // name a template could render. A site always has a name, so this never reaches the deployment.
    expect(resolveBrand(env, site({}))).toBe('The Blog')
  })

  test("a site's sender display name is the brand when it set one", () => {
    expect(resolveBrand(env, site({ emailFromName: 'The Blog Weekly' }))).toBe('The Blog Weekly')
  })

  test('an empty sender name is not a brand — the site name still answers', () => {
    expect(resolveBrand(env, site({ emailFromName: '' }))).toBe('The Blog')
  })
})
