/** Wire format shared by the Worker API and the admin client. */

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  /**
   * The site selector on the request matches no site. Its own code because a client can act on
   * it — the admin drops the site it had remembered and carries on, where a bare `not_found`
   * would be indistinguishable from the entry or collection the request was actually for.
   */
  | 'unknown_site'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'internal_error'

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode
    message: string
    /** Field-level validation details, keyed by dot-path. */
    details?: Record<string, string[]>
  }
}

export interface Paginated<T> {
  data: T[]
  /** Opaque cursor for the next page, or `null` when the list is exhausted. */
  nextCursor: string | null
}

export const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unknown_site: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal_error: 500,
}

export const SESSION_COOKIE = 'hedge_session'
export const API_VERSION = 'v1'
