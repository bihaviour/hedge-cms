import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_UPLOAD_BYTES } from '@hedge/core'
import { ApiError } from './errors'
import { fetchRemoteFile } from './remote-file'

/**
 * `upload_media` lets a delegated MCP client name a URL the Worker then fetches, which is the only
 * outbound request in this deployment driven by caller input. What is pinned here is what it
 * *refuses* — the scheme, the host, the redirect, the claimed size — because every one of those is
 * a refusal nothing else in the stack would make, and a regression in any of them is an SSRF hole
 * that behaves perfectly on a well-formed URL.
 */

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function respondWith(response: Response) {
  globalThis.fetch = (async () => response.clone()) as unknown as typeof fetch
}

/** The error a refusal produced, or `null` if the call unexpectedly succeeded. */
async function refusal(url: string): Promise<ApiError | null> {
  try {
    await fetchRemoteFile(url)
    return null
  } catch (error) {
    return error instanceof ApiError ? error : null
  }
}

describe('scheme', () => {
  test('refuses anything that is not https', async () => {
    for (const url of [
      'http://example.com/a.png',
      'file:///etc/passwd',
      'data:image/png;base64,iVBORw0KGgo=',
      'ftp://example.com/a.png',
    ]) {
      const error = await refusal(url)
      expect(error?.code).toBe('bad_request')
    }
  })

  test('refuses a string that is not a URL at all', async () => {
    expect((await refusal('not a url'))?.code).toBe('bad_request')
  })
})

describe('host', () => {
  // The classic SSRF targets. 169.254.169.254 is the cloud metadata address specifically.
  test.each([
    'https://localhost/a.png',
    'https://app.localhost/a.png',
    'https://something.internal/a.png',
    'https://printer.local/a.png',
    'https://127.0.0.1/a.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/a.png',
    'https://172.16.4.1/a.png',
    'https://172.31.255.255/a.png',
    'https://192.168.1.1/a.png',
    'https://100.64.0.1/a.png',
    'https://0.0.0.0/a.png',
    'https://[::1]/a.png',
    'https://[fd00::1]/a.png',
    'https://[fe80::1]/a.png',
    'https://[::ffff:127.0.0.1]/a.png',
  ])('refuses %s', async (url) => {
    expect((await refusal(url))?.code).toBe('bad_request')
  })

  /**
   * One address, many spellings. The WHATWG parser normalises the readable forms — and it
   * normalises `[0:0:0:0:0:ffff:127.0.0.1]` *into* `[::ffff:7f00:1]`, so a check that only
   * understood the dotted form would never fire on anything `new URL()` actually produces. Every
   * one of these is 127.0.0.1 or 10.0.0.1 wearing a different hat.
   */
  test.each([
    ['decimal', 'https://2130706433/'],
    ['hex', 'https://0x7f000001/'],
    ['octal', 'https://017700000001/'],
    ['short form', 'https://127.1/'],
    ['v4-mapped, hex groups', 'https://[::ffff:7f00:1]/'],
    ['v4-mapped, dotted', 'https://[::ffff:127.0.0.1]/'],
    ['v4-mapped, uncompressed', 'https://[0:0:0:0:0:ffff:127.0.0.1]/'],
    ['v4-mapped private', 'https://[::ffff:a00:1]/'],
    ['v4-compatible', 'https://[::7f00:1]/'],
    ['NAT64', 'https://[64:ff9b::7f00:1]/'],
  ])('refuses loopback written as %s', async (_form, url) => {
    expect((await refusal(url))?.code).toBe('bad_request')
  })

  test('allows a public address in an IPv6 wrapper', async () => {
    // 93.184.216.34 is public, so the unwrapping must not block by itself.
    respondWith(new Response('x', { headers: { 'content-type': 'image/png' } }))
    expect(await fetchRemoteFile('https://[::ffff:5db8:d822]/a.png')).toBeDefined()
    expect(await fetchRemoteFile('https://[2606:2800:220:1::]/a.png')).toBeDefined()
  })

  test('allows a public host that only looks private', async () => {
    // 172.32 is outside 172.16/12, and 192.169 outside 192.168/16 — the two ranges a check written
    // from memory gets wrong in the permissive direction.
    respondWith(new Response('x', { headers: { 'content-type': 'image/png' } }))
    expect(await fetchRemoteFile('https://172.32.0.1/a.png')).toBeDefined()
    expect(await fetchRemoteFile('https://192.169.0.1/a.png')).toBeDefined()
  })
})

describe('response', () => {
  test('does not follow a redirect', async () => {
    respondWith(
      new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/a.png' } }),
    )
    const error = await refusal('https://example.com/a.png')
    expect(error?.code).toBe('bad_request')
    expect(error?.message).toContain('redirects are not followed')
  })

  test('refuses a claimed length over the cap before reading a byte', async () => {
    respondWith(
      new Response('x', {
        headers: {
          'content-type': 'image/png',
          'content-length': String(MAX_UPLOAD_BYTES + 1),
        },
      }),
    )
    expect((await refusal('https://example.com/big.png'))?.code).toBe('payload_too_large')
  })

  test('refuses a non-2xx', async () => {
    respondWith(new Response('nope', { status: 404 }))
    expect((await refusal('https://example.com/missing.png'))?.code).toBe('bad_request')
  })

  test('takes the content type from the response, not the URL', async () => {
    // The extension says PNG and the server says PDF. The server is the one that knows.
    respondWith(
      new Response('x', { headers: { 'content-type': 'application/pdf; charset=binary' } }),
    )
    const file = await fetchRemoteFile('https://example.com/report.png')
    expect(file.contentType).toBe('application/pdf; charset=binary')
  })

  test('derives a filename from the path', async () => {
    respondWith(new Response('x', { headers: { 'content-type': 'image/png' } }))
    expect((await fetchRemoteFile('https://example.com/a/b/photo%20one.png')).filename).toBe(
      'photo one.png',
    )
  })
})
