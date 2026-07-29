/**
 * A hand-rolled typed client over the Cloudflare REST API — no SDK.
 *
 * `cloudflare-typescript` abstracts the multipart asset upload nicely, but this code ships inside
 * the Worker bundle that serves *every* request, and the SDK's bundle cost buys convenience we use
 * on exactly one route. So the four modules beside this one (`assets`, `scripts`, `d1`, `tokens`)
 * are a thin `fetch` wrapper over the handful of endpoints an update touches, and nothing more.
 *
 * Every Cloudflare response is `{ success, errors, messages, result }`. A non-2xx status or
 * `success: false` becomes a `CloudflareError` carrying the status and the API's own error codes,
 * so the update preflight can turn a 403 into "the token is missing <permission>".
 */

const API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CloudflareApiError {
  code: number
  message: string
}

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly errors: CloudflareApiError[],
    message: string,
  ) {
    super(message)
    this.name = 'CloudflareError'
  }

  /** True for the statuses a bad or under-scoped token produces, so the preflight can name it. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403
  }

  static from(status: number, body: unknown): CloudflareError {
    const errors = Array.isArray((body as { errors?: unknown })?.errors)
      ? ((body as { errors: CloudflareApiError[] }).errors ?? [])
      : []
    const message = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${status}`
    return new CloudflareError(status, errors, message)
  }
}

interface CloudflareEnvelope<T> {
  success: boolean
  errors: CloudflareApiError[]
  messages: unknown[]
  result: T
}

export interface CloudflareClient {
  readonly accountId: string
  /** A JSON request authenticated with the account API token. */
  request<T>(method: string, path: string, body?: unknown): Promise<T>
  /**
   * A multipart request. `bearer` overrides the account token — the asset-upload endpoint
   * authenticates with the short-lived JWT the upload session returns, not the operator's token.
   */
  requestForm<T>(
    method: string,
    path: string,
    form: FormData,
    options?: { bearer?: string; query?: Record<string, string> },
  ): Promise<T>
}

/**
 * Build a client bound to one account and one token. The token stays in this closure — it is never
 * stored, and the update route holds the client only for the life of the request.
 */
export function cloudflareClient(accountId: string, token: string): CloudflareClient {
  const authHeader = `Bearer ${token}`

  async function unwrap<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null
    if (!response.ok || !body?.success) {
      throw CloudflareError.from(response.status, body)
    }
    return body.result
  }

  return {
    accountId,

    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: authHeader,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      return unwrap<T>(response)
    },

    async requestForm<T>(
      method: string,
      path: string,
      form: FormData,
      options?: { bearer?: string; query?: Record<string, string> },
    ): Promise<T> {
      const query = options?.query ? `?${new URLSearchParams(options.query)}` : ''
      const response = await fetch(`${API_BASE}${path}${query}`, {
        method,
        // No `content-type`: the runtime sets the multipart boundary itself.
        headers: { authorization: options?.bearer ? `Bearer ${options.bearer}` : authHeader },
        body: form,
      })
      return unwrap<T>(response)
    },
  }
}
