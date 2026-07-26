import { describe, expect, test } from 'bun:test'
import { compareVersions, isUpdateAvailable, parseVersion } from './version'

describe('parseVersion', () => {
  test('parses x.y.z and tolerates a leading v', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion('v0.4.0')).toEqual({ major: 0, minor: 4, patch: 0 })
  })

  test('ignores a prerelease or build suffix', () => {
    expect(parseVersion('2.0.0-rc.1')).toEqual({ major: 2, minor: 0, patch: 0 })
  })

  test('returns null for nonsense', () => {
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
  })
})

describe('compareVersions', () => {
  test('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
  })
})

describe('isUpdateAvailable', () => {
  test('only a strictly newer latest counts', () => {
    expect(isUpdateAvailable('0.1.0', '0.2.0')).toBe(true)
    expect(isUpdateAvailable('0.2.0', '0.2.0')).toBe(false)
    expect(isUpdateAvailable('0.3.0', '0.2.0')).toBe(false)
  })

  test('a null latest (the check could not reach GitHub) is never an update', () => {
    expect(isUpdateAvailable('0.1.0', null)).toBe(false)
  })
})
