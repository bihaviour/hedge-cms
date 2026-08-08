import { type ApiErrorBody, type ApiErrorCode, HTTP_STATUS_BY_CODE } from '@hedge/core'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ZodError } from 'zod'

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  get status(): ContentfulStatusCode {
    return HTTP_STATUS_BY_CODE[this.code] as ContentfulStatusCode
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }

  static badRequest(message: string, details?: Record<string, string[]>) {
    return new ApiError('bad_request', message, details)
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError('unauthorized', message)
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new ApiError('forbidden', message)
  }

  static notFound(what = 'Resource') {
    return new ApiError('not_found', `${what} not found`)
  }

  /**
   * The site the request asked for does not exist. Still a 404, but distinguishable, so the admin
   * can tell "the site I remembered is gone" from "the entry you asked for is gone".
   */
  static unknownSite(selector: string) {
    return new ApiError('unknown_site', `No site matches "${selector}"`)
  }

  static conflict(message: string) {
    return new ApiError('conflict', message)
  }

  /**
   * A publish blocked by the collection's approval workflow. A conflict by status, but its own code
   * so the admin can steer the author to the version route rather than only reporting a failure.
   */
  static approvalRequired(message: string) {
    return new ApiError('approval_required', message)
  }

  static rateLimited(message = 'Too many requests — try again shortly') {
    return new ApiError('rate_limited', message)
  }

  /**
   * The provider refused an email the request could not complete without. Distinct from
   * `internal_error` so the caller can name the dependency that failed instead of reporting that
   * everything did.
   */
  static emailDeliveryFailed(message: string) {
    return new ApiError('email_delivery_failed', message)
  }

  static fromZod(error: ZodError): ApiError {
    const details: Record<string, string[]> = {}
    for (const issue of error.issues) {
      const path = issue.path.join('.') || '_'
      const messages = details[path] ?? []
      messages.push(issue.message)
      details[path] = messages
    }
    return new ApiError('bad_request', 'Validation failed', details)
  }
}

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json(err.toBody(), err.status)
  }

  console.error('unhandled error', err)
  const body: ApiErrorBody = {
    error: { code: 'internal_error', message: 'Something went wrong' },
  }
  return c.json(body, 500)
}
