import { describe, expect, test } from 'bun:test'
import { DEFAULT_EMAIL_TEMPLATES } from '@hedge/core'
import { renderMessage } from './render'

const vars = { to: 'reader@example.com', name: 'Alex', url: 'https://cms.example/accept?token=abc' }

describe('renderMessage', () => {
  test('interpolates variables into subject, heading and body', () => {
    const message = renderMessage('Hedge', DEFAULT_EMAIL_TEMPLATES.member_invite, vars)

    expect(message.subject).toBe('Set up your Hedge account')
    expect(message.to).toBe('reader@example.com')
    expect(message.html).toContain('Hi Alex, your account is ready')
    expect(message.html).toContain('reader@example.com')
    // The button and the paste-fallback both carry the link.
    expect(message.html).toContain(vars.url)
  })

  test('renders the call-to-action button only when a label is set', () => {
    const withCta = renderMessage('Hedge', DEFAULT_EMAIL_TEMPLATES.invite, vars)
    expect(withCta.html).toContain('Accept invite')

    const withoutCta = renderMessage(
      'Hedge',
      { subject: 'Hi', heading: 'Hi', body: '<p>No button here</p>', ctaLabel: null },
      vars,
    )
    expect(withoutCta.html).not.toContain('Or paste this link')
  })

  test('escapes variable values interpolated into HTML, but not the author-written body', () => {
    const message = renderMessage(
      'Hedge',
      { subject: 'Hi', heading: 'Welcome {{name}}', body: '<p>Hello {{name}}</p>', ctaLabel: null },
      { ...vars, name: '<script>alert(1)</script>' },
    )

    // The injected name is neutralised...
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(message.html).not.toContain('<script>alert(1)</script>')
    // ...while the template's own markup is preserved.
    expect(message.html).toContain('<p>Hello')
  })

  test('the plain-text version strips markup and ends with the link', () => {
    const message = renderMessage('Hedge', DEFAULT_EMAIL_TEMPLATES.member_verify, vars)

    expect(message.text).not.toContain('<')
    expect(message.text).toContain('reader@example.com')
    expect(message.text.trim().endsWith(vars.url)).toBe(true)
  })
})
