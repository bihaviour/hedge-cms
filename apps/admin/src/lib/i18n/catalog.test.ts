import { describe, expect, test } from 'bun:test'
import { en } from './catalog'
import { id } from './id'

/**
 * A key present in one catalog and missing from the other is the failure mode here: English is the
 * source of truth, so a gap in a translation degrades to English silently and can sit unnoticed for
 * a release. Typing already stops `id` holding a key `en` does not have; this catches the other
 * direction, which nothing else would.
 */
describe('message catalogs', () => {
  test('every English message has an Indonesian translation', () => {
    const missing = Object.keys(en).filter((key) => !(key in id))
    expect(missing).toEqual([])
  })

  test('placeholders match between the two catalogs', () => {
    const placeholders = (message: string) =>
      [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

    const mismatched = Object.entries(en)
      .filter(([key, message]) => {
        const translated = id[key as keyof typeof en]
        if (!translated) return false
        return placeholders(message).join() !== placeholders(translated).join()
      })
      .map(([key]) => key)

    expect(mismatched).toEqual([])
  })
})
