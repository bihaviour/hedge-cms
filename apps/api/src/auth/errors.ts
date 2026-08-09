import type { ApiErrorCode } from '@hedge/core'
import { isAPIError } from 'better-auth/api'
import { ApiError } from '../lib/errors'

/**
 * Better Auth's HTTP status, as one of our error codes.
 *
 * There are two ways into Better Auth from here and they used to answer differently. The facade
 * goes through its HTTP handler (`forwardToAuth`) and mapped the status; the member routes call
 * `auth.api.*` directly and mapped nothing, so an `APIError` reached `app.onError`, which only
 * recognises `ApiError`, and every refusal it could make arrived as `500 internal_error` (#131).
 * Both now translate through this one table, so a rejected token answers the same whichever door it
 * came through. A status not in it is a failure of Better Auth's own and becomes `internal_error`.
 */
const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'bad_request',
  429: 'rate_limited',
}

/**
 * Better Auth refused with `status`, as an `ApiError` the caller can render.
 *
 * `path` names what was being attempted. Better Auth logs the cause itself but not the endpoint, so
 * without it a 500 on sign-in and a 500 on a password change are the same line in `wrangler tail`.
 */
export function authError(
  status: number,
  message: string,
  path: string,
  detail?: unknown,
): ApiError {
  const code = CODE_BY_STATUS[status] ?? 'internal_error'
  if (code !== 'internal_error') return new ApiError(code, message)

  console.error('better-auth error', path, status, detail)
  return new ApiError(
    'internal_error',
    'The authentication service failed. The cause is in this deployment’s Worker logs.',
  )
}

/**
 * The same translation for an error *thrown* by a direct `auth.api.*` call, which is how the member
 * routes reach Better Auth (#131).
 *
 * A website hosting the member auth pages has to tell a reader one of two very different things —
 * "that link expired, ask for a new one" or "the CMS is having a bad day, try again" — and with
 * both arriving as a 500 it cannot choose. Guessing wrong leaves a reader retrying a link that will
 * never work. So a refusal keeps the status Better Auth chose, which is also what lets a `429`
 * survive as `rate_limited` instead of being flattened into the same answer as a dead token.
 *
 * `message` replaces Better Auth's, which is written for whoever wrote the client ("Invalid token")
 * rather than for the person who followed the link. It reaches the caller only for a status the
 * table recognises: a failure of Better Auth's own still reports nothing about the request.
 *
 * Anything that is not an `APIError` is a genuine crash — a thrown `TypeError`, a D1 outage — and
 * is deliberately not laundered into a 4xx. That is the one thing the caller must still be able to
 * tell apart, so it takes the `internal_error` path with its log line.
 */
export function authApiError(error: unknown, path: string, message: string): ApiError {
  if (!isAPIError(error)) return authError(500, message, path, error)
  return authError(error.statusCode, message, path, error.body)
}
