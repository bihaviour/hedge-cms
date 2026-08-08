import { describe, expect, test } from 'bun:test'
import { loggedSubject } from './redact'

/**
 * What `email_log` is allowed to remember about a send.
 *
 * `login_challenges.codeHash` is an HMAC so a sign-in code cannot be read back out of the database.
 * The subject line carries the code in the clear, and the log is served to anyone holding
 * `email:manage` — so without this, the log hands a live second factor to a whole tier of operators,
 * for accounts more privileged than their own. That is the escalation step-up verification exists to
 * prevent, which is why it is pinned rather than left to the comment beside it.
 */
describe('loggedSubject', () => {
  test('masks the code in a sign-in subject', () => {
    expect(loggedSubject('Your Hedge sign-in code is 377139', 'login_code')).toBe(
      'Your Hedge sign-in code is ••••••',
    )
  })

  test('leaves no digit run a code could hide in', () => {
    // Subjects are editable (`PUT /api/v1/email/templates/:key`), so redaction cannot key off the
    // wording the default template happens to use, or on where in the line the code sits.
    for (const subject of [
      '377139 — masuk ke Hedge',
      'kode: 377139 (berlaku 10 menit)',
      'Hedge 2026 sign-in code is 377139',
    ]) {
      expect(loggedSubject(subject, 'login_code')).not.toContain('377139')
    }
  })

  test('every other template keeps its subject verbatim', () => {
    // The log is how an operator finds a specific send, so redacting more than necessary costs
    // something real. Only `login_code` carries a credential.
    expect(loggedSubject('Reset your Hedge password', 'password_reset')).toBe(
      'Reset your Hedge password',
    )
    expect(loggedSubject('You are invited to Hedge on 2026-08-07', 'invite')).toBe(
      'You are invited to Hedge on 2026-08-07',
    )
    expect(loggedSubject('Your Hedge sign-in code is 377139', undefined)).toBe(
      'Your Hedge sign-in code is 377139',
    )
  })
})
