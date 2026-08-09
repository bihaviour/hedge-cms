import { describe, expect, test } from 'bun:test'
import {
  buildEntryValidator,
  createEmailSenderSchema,
  createEntrySchema,
  createSiteSchema,
  entryMetadataSchema,
  type Field,
  fieldsSchema,
  isValidTimeZone,
  listEntriesQuerySchema,
  localeCodeSchema,
  memberRegisterSchema,
  setSiteRoleSchema,
  siteI18nSchema,
  siteMetadataSchema,
  updateCollectionSchema,
  updateEntrySchema,
  updateSenderAssignmentSchema,
  updateSiteConfigSchema,
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

  test('issues a delivery key by default, and can opt out for scripted creation', () => {
    expect(createSiteSchema.parse({ slug: 'docs', name: 'Docs' }).createDeliveryKey).toBe(true)
    expect(
      createSiteSchema.parse({ slug: 'docs', name: 'Docs', createDeliveryKey: false })
        .createDeliveryKey,
    ).toBe(false)
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

describe('siteMetadataSchema', () => {
  test('fills empty defaults for the array fields', () => {
    const parsed = siteMetadataSchema.parse({})
    expect(parsed.keywords).toEqual([])
    expect(parsed.custom).toEqual([])
  })

  test('rejects a custom metadata key that is unsafe to emit into a tag', () => {
    expect(
      siteMetadataSchema.safeParse({ custom: [{ key: 'og:title', value: 'ok' }] }).success,
    ).toBe(true)
    expect(
      siteMetadataSchema.safeParse({ custom: [{ key: 'has spaces', value: 'x' }] }).success,
    ).toBe(false)
  })
})

describe('entryMetadataSchema', () => {
  test('defaults noIndex off and custom to an empty record', () => {
    const parsed = entryMetadataSchema.parse({})
    expect(parsed.noIndex).toBe(false)
    expect(parsed.custom).toEqual({})
  })
})

describe('select field validator', () => {
  const options = [{ value: 'essay', label: 'Essay' }]
  const validatorFor = (field: Record<string, unknown>) =>
    buildEntryValidator(fieldsSchema.parse([field]) as Field[])

  test('creatable defaults off', () => {
    const [parsed] = fieldsSchema.parse([{ kind: 'select', name: 'tags', label: 'Tags', options }])
    expect(parsed && 'creatable' in parsed && parsed.creatable).toBe(false)
  })

  test('a closed multiple select rejects an undeclared value', () => {
    const v = validatorFor({ kind: 'select', name: 'tags', label: 'Tags', options, multiple: true })
    expect(v.safeParse({ tags: ['essay'] }).success).toBe(true)
    expect(v.safeParse({ tags: ['freeform'] }).success).toBe(false)
  })

  test('a creatable multiple select accepts any non-empty string', () => {
    const v = validatorFor({
      kind: 'select',
      name: 'tags',
      label: 'Tags',
      options,
      multiple: true,
      creatable: true,
    })
    expect(v.safeParse({ tags: ['essay', 'freeform', 'AI Agents'] }).success).toBe(true)
    // Still not a home for empty strings.
    expect(v.safeParse({ tags: [''] }).success).toBe(false)
  })
})

describe('listEntriesQuerySchema', () => {
  test('sort defaults to updatedAt and now accepts a declared-field path', () => {
    expect(listEntriesQuerySchema.parse({}).sort).toBe('updatedAt')
    expect(listEntriesQuerySchema.parse({ sort: 'data.date' }).sort).toBe('data.date')
    expect(listEntriesQuerySchema.parse({ sort: 'field:date' }).sort).toBe('field:date')
  })
})

describe('updateSiteConfigSchema', () => {
  test('accepts metadata and custom field definitions together', () => {
    const parsed = updateSiteConfigSchema.parse({
      metadata: { description: 'A site' },
      customFields: [{ kind: 'url', name: 'social', label: 'Social' }],
    })
    expect(parsed.metadata?.description).toBe('A site')
    expect(parsed.customFields?.[0]?.kind).toBe('url')
  })

  test('leaves both keys optional so one can be updated alone', () => {
    expect(updateSiteConfigSchema.parse({}).metadata).toBeUndefined()
  })

  test('carries no sender fields — sender assignment moved to the Email tab (#136)', () => {
    const parsed = updateSiteConfigSchema.parse({
      metadata: { description: 'A site' },
      // Extra keys are stripped by the schema rather than kept — proof they are not part of it.
      emailSender: { fromEmail: 'news@example.com' },
    } as Record<string, unknown>)
    expect('emailSender' in parsed).toBe(false)
  })
})

describe('email sender schemas (#136)', () => {
  test('a sender takes an address and optional name/reply-to', () => {
    const parsed = createEmailSenderSchema.parse({ email: 'mark@example.com', name: 'Mark' })
    expect(parsed).toEqual({ email: 'mark@example.com', name: 'Mark' })
  })

  test('rejects a sender address that is not an address', () => {
    expect(createEmailSenderSchema.safeParse({ email: 'not-an-address' }).success).toBe(false)
  })

  test('assignment takes two ids, either of which may be null to inherit the CMS sender', () => {
    const parsed = updateSenderAssignmentSchema.parse({
      memberSenderId: 'esnd_1',
      newsletterSenderId: null,
    })
    expect(parsed).toEqual({ memberSenderId: 'esnd_1', newsletterSenderId: null })
  })

  test('assignment requires both ids present, so a partial save cannot half-clear it', () => {
    expect(updateSenderAssignmentSchema.safeParse({ memberSenderId: 'esnd_1' }).success).toBe(false)
  })
})
