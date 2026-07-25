import { describe, expect, test } from 'bun:test'
import {
  createEntrySchema,
  createSiteSchema,
  memberRegisterSchema,
  updateCollectionSchema,
  updateEntrySchema,
} from './index'

describe('updateEntrySchema', () => {
  test('leaves omitted fields undefined instead of applying create-time defaults', () => {
    const parsed = updateEntrySchema.parse({ data: { title: 'Edited' } })
    // A `.partial()` of createEntrySchema would yield status 'draft' here and unpublish the entry.
    expect(parsed.status).toBeUndefined()
    expect(parsed.locale).toBeUndefined()
    expect(parsed.slug).toBeUndefined()
  })

  test('still accepts explicit values', () => {
    const parsed = updateEntrySchema.parse({ status: 'archived', locale: 'id' })
    expect(parsed.status).toBe('archived')
    expect(parsed.locale).toBe('id')
  })
})

describe('createEntrySchema', () => {
  test('applies defaults on create', () => {
    const parsed = createEntrySchema.parse({ data: {} })
    expect(parsed.status).toBe('draft')
    expect(parsed.locale).toBe('en')
  })

  test('entries are public unless asked otherwise', () => {
    expect(createEntrySchema.parse({ data: {} }).visibility).toBe('public')
    expect(createEntrySchema.parse({ data: {}, visibility: 'members' }).visibility).toBe('members')
  })
})

describe('updateEntrySchema visibility', () => {
  test('omitting visibility leaves it alone rather than unlocking the entry', () => {
    expect(updateEntrySchema.parse({ status: 'published' }).visibility).toBeUndefined()
  })
})

describe('createSiteSchema', () => {
  test('defaults member signup on and accepts a bare hostname', () => {
    const parsed = createSiteSchema.parse({
      slug: 'docs',
      name: 'Docs',
      domain: 'docs.example.com',
    })
    expect(parsed.allowMemberSignup).toBe(true)
    expect(parsed.domain).toBe('docs.example.com')
  })

  test('rejects a domain that is really a URL', () => {
    expect(
      createSiteSchema.safeParse({ slug: 'docs', name: 'Docs', domain: 'https://x.com/a' }).success,
    ).toBe(false)
  })
})

describe('memberRegisterSchema', () => {
  test('holds members to the same password length as CMS users', () => {
    const short = { email: 'a@b.com', name: 'A', password: 'short' }
    expect(memberRegisterSchema.safeParse(short).success).toBe(false)
    expect(
      memberRegisterSchema.safeParse({ ...short, password: 'long-enough-password' }).success,
    ).toBe(true)
  })
})

describe('updateCollectionSchema', () => {
  test('does not default `kind` when omitted', () => {
    expect(updateCollectionSchema.parse({ name: 'Renamed' }).kind).toBeUndefined()
  })
})
