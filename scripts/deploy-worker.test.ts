import { describe, expect, test } from 'bun:test'
import { repoUrlFromRemote } from './deploy-worker'

describe('repoUrlFromRemote', () => {
  test('passes a plain https remote through, dropping the .git suffix', () => {
    expect(repoUrlFromRemote('https://github.com/you/hedge-cms.git')).toBe(
      'https://github.com/you/hedge-cms',
    )
    expect(repoUrlFromRemote('https://gitlab.com/you/hedge-cms')).toBe(
      'https://gitlab.com/you/hedge-cms',
    )
  })

  test('rewrites the scp-like ssh form into https', () => {
    expect(repoUrlFromRemote('git@github.com:you/hedge-cms.git')).toBe(
      'https://github.com/you/hedge-cms',
    )
  })

  test('rewrites an ssh:// remote into https', () => {
    expect(repoUrlFromRemote('ssh://git@gitlab.com/you/hedge-cms.git')).toBe(
      'https://gitlab.com/you/hedge-cms',
    )
  })

  test('strips embedded credentials — a CI checkout may carry an access token', () => {
    // The value becomes a runtime var readable in the dashboard; a token must never survive.
    expect(
      repoUrlFromRemote('https://x-access-token:ghs_secret@github.com/you/hedge-cms.git'),
    ).toBe('https://github.com/you/hedge-cms')
  })

  test('tolerates surrounding whitespace, as `git remote get-url` output has a newline', () => {
    expect(repoUrlFromRemote('https://github.com/you/hedge-cms.git\n')).toBe(
      'https://github.com/you/hedge-cms',
    )
  })

  test('returns null rather than a mangled URL for anything unrecognisable', () => {
    expect(repoUrlFromRemote('')).toBeNull()
    expect(repoUrlFromRemote('not a remote')).toBeNull()
    expect(repoUrlFromRemote('https://github.com/')).toBeNull()
  })
})
