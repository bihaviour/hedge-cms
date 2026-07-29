import { describe, expect, test } from 'bun:test'
import { compareVersions, isUpdateAvailable, parseInstallMethod, parseVersion } from './version'

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

describe('parseInstallMethod', () => {
  test('recognises the three ways a deployment can exist', () => {
    expect(parseInstallMethod('button')).toBe('button')
    expect(parseInstallMethod('installer')).toBe('installer')
    expect(parseInstallMethod('cli')).toBe('cli')
  })

  test('tolerates whitespace and casing, because this is a hand-typed deployment var', () => {
    expect(parseInstallMethod('  Installer ')).toBe('installer')
    expect(parseInstallMethod('BUTTON')).toBe('button')
  })

  /**
   * The one that matters. Every deployment made before this var existed has it unset, and they must
   * keep seeing correct instructions — `null` is read as "show both update paths, claim no
   * repository", which is what the admin did before #39.
   */
  test('anything unrecognised degrades to null rather than to a guess', () => {
    expect(parseInstallMethod('')).toBeNull()
    expect(parseInstallMethod(undefined)).toBeNull()
    expect(parseInstallMethod(null)).toBeNull()
    expect(parseInstallMethod('terraform')).toBeNull()
    expect(parseInstallMethod('installer ; drop table users')).toBeNull()
  })
})
