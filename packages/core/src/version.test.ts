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

  /**
   * Each part is compared as a *number*, not as text. Lexicographically `'0.0.10' < '0.0.9'`, so a
   * string comparison would tell every 0.0.9 deployment it was already current the moment the patch
   * count reached double digits — and keep telling them, silently, for the rest of the 0.0.x line.
   */
  test('a double-digit part sorts numerically, not lexicographically', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBeGreaterThan(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('10.0.0', '9.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.100', '1.0.99')).toBeGreaterThan(0)
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

  /** The case above, as the update notice actually sees it — running 0.0.9, latest tag v0.0.10. */
  test('offers a double-digit patch to the release before it', () => {
    expect(isUpdateAvailable('0.0.9', 'v0.0.10')).toBe(true)
    expect(isUpdateAvailable('0.0.10', 'v0.0.9')).toBe(false)
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
