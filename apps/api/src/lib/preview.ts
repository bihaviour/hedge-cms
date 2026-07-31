import {
  buildPreviewUrl,
  type CreatePreviewTokenInput,
  PREVIEW_TOKEN_HEADER,
  type PreviewToken,
} from '@hedge/core'
import type { Context, MiddlewareHandler } from 'hono'
import type { SiteRow } from '../db/schema'
import type { AppEnv, Bindings } from '../env'
import { findCollection } from './collections'
import { fromBase64Url, hmac, timingSafeEqualString, toBase64Url } from './crypto'
import { getEntry } from './entries'

/**
 * Preview tokens — the fourth credential type in this deployment, and the one with the narrowest
 * reach of the four.
 *
 * It is stateless: a base64url payload signed with `AUTH_SECRET`, the same construction delivery API
 * keys and invite tokens already use. Verifying one costs no D1 round trip, which matters because
 * the path that redeems it is a website rendering a page. See `PREVIEW_TOKEN_DEFAULT_TTL_SECONDS`
 * in `@hedge/core` for what that trades away and why the trade is the right one here.
 *
 * Two rules govern where it may be resolved, and both are enforced outside this file:
 *
 * - **Minting** is `requireUserActor` only (`routes/entries.ts`). The prefix it lives under is in
 *   `KEY_MANAGED_PREFIXES`, so a write-scoped key would otherwise resolve there — and "only
 *   authorised CMS users can see unpublished content" is the whole point of the feature. A key
 *   sitting in a website's environment variables must not be able to manufacture a preview link.
 * - **Redeeming** happens only on `/api/v1/content/*` (`index.ts`), alongside the delivery actor,
 *   by the same middleware-level reasoning that keeps a delivery key out of the management API.
 *
 * A preview token is never a credential on its own. The request still needs the site's delivery key
 * to resolve an actor at all; the token only widens what that key may see, for one entry.
 */

/** Version tag, so the payload shape can change without an old token being read as a new one. */
const TOKEN_VERSION = 'hpv1'

export interface PreviewClaims {
  /** The site the token was minted on — checked against the resolved tenant on every redemption. */
  siteId: string
  collection: string
  slug: string
  locale: string
  /** Reserved for #59: the pending version an approver is reviewing. Absent until versions exist. */
  versionId?: string
  /** The user who minted it, so a leaked token is attributable. */
  userId: string
  /** Expiry, epoch seconds. */
  expiresAt: number
}

/** Compact wire form. Short keys because the whole thing travels in a URL. */
interface Payload {
  s: string
  c: string
  g: string
  l: string
  v?: string
  u: string
  e: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encodePayload(claims: PreviewClaims): string {
  const payload: Payload = {
    s: claims.siteId,
    c: claims.collection,
    g: claims.slug,
    l: claims.locale,
    ...(claims.versionId ? { v: claims.versionId } : {}),
    u: claims.userId,
    e: claims.expiresAt,
  }
  return toBase64Url(encoder.encode(JSON.stringify(payload)))
}

function decodePayload(encoded: string): PreviewClaims | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(fromBase64Url(encoded)))
  } catch {
    return null
  }

  const payload = parsed as Payload
  if (
    typeof payload?.s !== 'string' ||
    typeof payload.c !== 'string' ||
    typeof payload.g !== 'string' ||
    typeof payload.l !== 'string' ||
    typeof payload.u !== 'string' ||
    typeof payload.e !== 'number'
  ) {
    return null
  }

  return {
    siteId: payload.s,
    collection: payload.c,
    slug: payload.g,
    locale: payload.l,
    ...(typeof payload.v === 'string' ? { versionId: payload.v } : {}),
    userId: payload.u,
    expiresAt: payload.e,
  }
}

/** Signs a set of claims into `hpv1.<payload>.<signature>`. */
export async function signPreviewToken(env: Bindings, claims: PreviewClaims): Promise<string> {
  const payload = encodePayload(claims)
  const body = `${TOKEN_VERSION}.${payload}`
  return `${body}.${await hmac(env.AUTH_SECRET, body)}`
}

/**
 * The claims a token carries, or `null` when it is malformed, signed with another secret, tampered
 * with, or expired. Never throws: an unusable preview token is simply not a preview, and the
 * request falls back to the published view.
 */
export async function verifyPreviewToken(
  env: Bindings,
  token: string,
): Promise<PreviewClaims | null> {
  const [version, payload, signature] = token.split('.')
  if (version !== TOKEN_VERSION || !payload || !signature) return null

  const expected = await hmac(env.AUTH_SECRET, `${version}.${payload}`)
  if (!timingSafeEqualString(signature, expected)) return null

  const claims = decodePayload(payload)
  if (!claims) return null
  if (claims.expiresAt * 1000 <= Date.now()) return null

  return claims
}

/**
 * Resolves a preview token off the request, for the delivery API only.
 *
 * Runs after `resolveSite`, so the token's own site can be checked against the tenant the request
 * resolved to — a token minted on site A presented against site B resolves to nothing rather than
 * to a cross-tenant read. Matching the *entry* is the route's job (`previewFor`), because only the
 * route knows which collection, slug and locale were asked for.
 */
export const resolvePreview: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('preview', await previewFromToken(c))
  await next()
}

async function previewFromToken(c: Context<AppEnv>): Promise<PreviewClaims | null> {
  const token = c.req.header(PREVIEW_TOKEN_HEADER)?.trim()
  if (!token) return null

  const site = c.get('site')
  if (!site) return null

  const claims = await verifyPreviewToken(c.env, token)
  return claims && claims.siteId === site.id ? claims : null
}

/**
 * The preview in flight, but only if it is a preview of *this* entry. A token bound to one slug
 * must not unlock its neighbour, or the same slug in another locale — that scoping is the whole
 * reason the token names an entry rather than a site.
 */
export function previewFor(
  c: Context<AppEnv>,
  collection: string,
  slug: string,
  locale: string,
): PreviewClaims | null {
  const claims = c.get('preview')
  if (!claims) return null

  const matches =
    claims.collection === collection && claims.slug === slug && claims.locale === locale
  return matches ? claims : null
}

/**
 * Mints a token for one entry, and resolves the website URL to open it at.
 *
 * The entry is loaded first, so minting a link to something that does not exist fails here rather
 * than as a 404 on somebody else's website. `url` is null when the site has configured no
 * `previewUrl` — the admin shows that as "set one up" instead of a button that goes nowhere.
 */
export async function mintPreviewToken(
  env: Bindings,
  site: SiteRow,
  collectionSlug: string,
  slug: string,
  input: CreatePreviewTokenInput,
  userId: string,
): Promise<PreviewToken> {
  const locale = input.locale ?? site.defaultLocale
  const entry = await getEntry(env, site, collectionSlug, slug, locale)
  const collection = await findCollection(env, site.id, collectionSlug)

  const expiresAt = Math.floor(Date.now() / 1000) + input.ttlSeconds
  const claims: PreviewClaims = {
    siteId: site.id,
    collection: collectionSlug,
    slug: entry.slug,
    locale: entry.locale,
    ...(input.versionId ? { versionId: input.versionId } : {}),
    userId,
    expiresAt,
  }

  const token = await signPreviewToken(env, claims)

  return {
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    url: site.previewUrl
      ? buildPreviewUrl({
          previewUrl: site.previewUrl,
          previewPath: collection.previewPath,
          collection: collectionSlug,
          slug: entry.slug,
          locale: entry.locale,
          token,
        })
      : null,
  }
}
