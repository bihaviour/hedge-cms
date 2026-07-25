import { describe, expect, test } from 'bun:test'
import {
  createEntrySchema,
  createSiteSchema,
  isValidTimeZone,
  localeCodeSchema,
  memberRegisterSchema,
  setSiteRoleSchema,
  siteI18nSchema,
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
  test('applies defaults on create, but leaves locale for the route to fill from site config', () => {
    const parsed = createEntrySchema.parse({ data: {} })
    expect(parsed.status).toBe('draft')
    // Not defaulted to 'en': the route substitutes the site's own default locale.
    expect(parsed.locale).toBeUndefined()
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

  test('seeds English-only, UTC i18n defaults', () => {
    const parsed = createSiteSchema.parse({ slug: 'docs', name: 'Docs' })
    expect(parsed.locales).toEqual(['en'])
    expect(parsed.defaultLocale).toBe('en')
    expect(parsed.timezone).toBe('UTC')
  })

  test('rejects a default locale the site does not publish', () => {
    const result = createSiteSchema.safeParse({
      slug: 'docs',
      name: 'Docs',
      locales: ['en', 'id'],
      defaultLocale: 'fr',
    })
    expect(result.success).toBe(false)
  })

  test('accepts a bilingual site with a matching default and a real timezone', () => {
    const parsed = createSiteSchema.parse({
      slug: 'docs',
      name: 'Docs',
      locales: ['en', 'id'],
      defaultLocale: 'id',
      timezone: 'Asia/Jakarta',
    })
    expect(parsed.locales).toEqual(['en', 'id'])
    expect(parsed.defaultLocale).toBe('id')
    expect(parsed.timezone).toBe('Asia/Jakarta')
  })
})

describe('siteI18nSchema', () => {
  test('rejects duplicate locales', () => {
    const result = siteI18nSchema.safeParse({
      locales: ['en', 'en'],
      defaultLocale: 'en',
      timezone: 'UTC',
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown timezone', () => {
    const result = siteI18nSchema.safeParse({
      locales: ['en'],
      defaultLocale: 'en',
      timezone: 'Mars/Olympus_Mons',
    })
    expect(result.success).toBe(false)
  })
})

describe('localeCodeSchema', () => {
  test('accepts language and region tags but not free text', () => {
    expect(localeCodeSchema.safeParse('en').success).toBe(true)
    expect(localeCodeSchema.safeParse('pt-BR').success).toBe(true)
    expect(localeCodeSchema.safeParse('zh-Hant').success).toBe(true)
    expect(localeCodeSchema.safeParse('English').success).toBe(false)
    expect(localeCodeSchema.safeParse('e').success).toBe(false)
  })
})

describe('isValidTimeZone', () => {
  test('knows real IANA zones from made-up ones', () => {
    expect(isValidTimeZone('Asia/Jakarta')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Nowhere/Fake')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('setSiteRoleSchema', () => {
  test('accepts site roles but not owner — owner is an instance role', () => {
    expect(setSiteRoleSchema.safeParse({ role: 'admin' }).success).toBe(true)
    expect(setSiteRoleSchema.safeParse({ role: 'viewer' }).success).toBe(true)
    expect(setSiteRoleSchema.safeParse({ role: 'owner' }).success).toBe(false)
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
