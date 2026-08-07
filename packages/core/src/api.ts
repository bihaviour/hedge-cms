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
  /**
   * The collection requires approvals this write has not got: publishing an entry directly where
   * the workflow is switched on, or publishing a version that has not cleared every level. A
   * conflict by status, but its own code because the admin acts on it — it steers the author to
   * the version they should be opening instead of just reporting a failure.
   */
  | 'approval_required'
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

/**
 * A page of a list, as it crosses the wire. Declared once here and imported by both sides — every
 * list helper used to re-declare this inline, which is the duplication `CLAUDE.md` forbids.
 *
 * A **type alias and not an interface**, for the same reason `CreateSiteResult` is: an interface
 * has no index signature, so it does not satisfy `ToolResult.structured`'s `Record<string, unknown>`
 * and every MCP list tool that answers with a page would stop compiling.
 */
export type Paginated<T> = {
  data: T[]
  /** Opaque cursor for the next page, or `null` when the list is exhausted. */
  nextCursor: string | null
  /**
   * Rows matching the filters, ignoring the cursor and the limit — what a table renders as
   * "of 137". Optional, and its absence is a *fact* rather than an omission to be tidied up: a
   * list that cannot count itself exactly sends nothing rather than an approximation a caller
   * would print as one (#123).
   *
   * The review queue is the case that forces this. "Waiting on you" is derived in JS from the
   * decisions recorded against a version and who wrote it — not a predicate a `WHERE` can hold —
   * so `countReviewQueue` is already capped at 100 for the sidebar badge, and a number that stops
   * at 100 must not be presented as a total.
   *
   * The delivery API sends none either, for a different reason: `/api/v1/content/*` is the cached
   * public path, and a second query per request spends the budget its `s-maxage` exists to protect.
   */
  total?: number
}

/**
 * What a caller sends to walk a keyset-paginated list. The routes keep validating with their own
 * zod schemas rather than one shared schema, because the `limit` cap differs per list (media
 * defaults to 24, the email log to 50); this is the shape the *client* builds.
 */
export type PageQuery = {
  limit?: number
  cursor?: string
}

export const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unknown_site: 404,
  conflict: 409,
  approval_required: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal_error: 500,
}

export const SESSION_COOKIE = 'hedge_session'
export const API_VERSION = 'v1'
