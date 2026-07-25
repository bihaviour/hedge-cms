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

  static conflict(message: string) {
    return new ApiError('conflict', message)
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
