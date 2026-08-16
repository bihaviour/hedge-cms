import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'
import { authApiError, authError } from './errors'

// The bug this pins (#131): the member routes call `auth.api.*` directly, so Better Auth's own
// `APIError` reached `app.onError` — which recognises only `ApiError` — and every refusal it could
// make arrived at the caller as `500 internal_error`. A website hosting the member auth pages
// cannot word "that link expired" versus "try again shortly" from a single status.

/** What the caller ends up with for a Better Auth failure thrown by a direct `auth.api.*` call. */
function thrownAs(
  status: ConstructorParameters<typeof APIError>[0],
  body?: Record<string, unknown>,
) {
  const error = authApiError(
    new APIError(status, body),
    '/reset-password',
    'That reset link is invalid or has expired',
  )
  return { code: error.code, status: error.status, message: error.message }
}

describe('authApiError', () => {
  test('an expired or spent token is a 400 the caller can branch on, not a 500', () => {
    expect(thrownAs('BAD_REQUEST', { message: 'Invalid token', code: 'INVALID_TOKEN' })).toEqual({
      code: 'bad_request',
      status: 400,
      message: 'That reset link is invalid or has expired',
    })
  })

  // A dead verification link is Better Auth's `UNAUTHORIZED`, and it stays one.
  test('keeps the status Better Auth chose rather than flattening every refusal to 400', () => {
    expect(thrownAs('UNAUTHORIZED').code).toBe('unauthorized')
    expect(thrownAs('FORBIDDEN').code).toBe('forbidden')
    expect(thrownAs('NOT_FOUND').code).toBe('not_found')
    expect(thrownAs('CONFLICT').code).toBe('conflict')
  })

  // The reason for mapping the status rather than answering `badRequest` for anything that throws:
  // "you are being throttled" and "your link is dead" are different things to tell a reader.
  test('a throttled call survives as rate_limited', () => {
    expect(thrownAs('TOO_MANY_REQUESTS')).toEqual({
      code: 'rate_limited',
      status: 429,
      message: 'That reset link is invalid or has expired',
    })
  })

  // `UNPROCESSABLE_ENTITY` is a validation failure by another name, so it lands on `bad_request`.
  test('422 is bad_request, as it is through the facade', () => {
    expect(thrownAs('UNPROCESSABLE_ENTITY').code).toBe('bad_request')
  })

  test('a failure of Better Auth’s own is still a 500, and says nothing about the request', () => {
    const error = thrownAs('INTERNAL_SERVER_ERROR', { message: 'the database is on fire' })
    expect(error.code).toBe('internal_error')
    expect(error.message).not.toContain('fire')
  })

  // The distinction that has to survive: a thrown `TypeError` is a crash, and laundering it into a
  // 4xx would tell a website its reader's link was bad when the CMS is the thing that is broken.
  test('a genuine crash is not laundered into a rejected token', () => {
    const error = authApiError(new TypeError('undefined is not a function'), '/reset-password', 'x')
    expect(error.code).toBe('internal_error')
    expect(error.status).toBe(500)
  })
})

describe('authError', () => {
  test('an unmapped status is a failure of the service, not of the request', () => {
    expect(authError(503, 'Authentication failed', '/sign-in/email').code).toBe('internal_error')
  })

  test('a mapped status carries the message it was given', () => {
    const error = authError(401, 'Incorrect email or password', '/sign-in/email')
    expect(error.status).toBe(401)
    expect(error.message).toBe('Incorrect email or password')
  })
})
