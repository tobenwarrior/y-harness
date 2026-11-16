/** Browser-side metadata reader for an owner-approved saved website login. */

import type { Branded } from '@yharness/brand'
import { createBotRequestPoller, type BotRequestPoller } from './bot-request-poller.ts'

/** Opaque identifier issued by the authenticated Cloud website-login broker. */
export type BotWebsiteLoginRequestId = Branded<'BotWebsiteLoginRequestId'>

/** Validated, non-secret metadata for one paused website sign-in. */
export interface BotWebsiteLoginRequest {
  readonly id: BotWebsiteLoginRequestId
  readonly origin: string
  readonly destination: string
  readonly scope?: 'shared'
}

/** Fetch seam used by the browser reader and lifecycle tests. */
export type BotWebsiteLoginRequestFetcher = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<BotWebsiteLoginRequest | null>

/** Result callback for one selected session's validated metadata. */
export type BotWebsiteLoginRequestResult = (
  sessionId: string,
  request: BotWebsiteLoginRequest | null,
) => void

const REQUEST_ID = /^[a-f0-9]{32}$/u
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  let url: URL
  try { url = new URL(value) }
  catch { return false }
  const labels = url.hostname.split('.')
  return url.protocol === 'https:' && url.username === '' && url.password === ''
    && url.pathname === '/' && url.search === '' && url.hash === '' && url.origin === value
    && labels.length >= 2 && labels.every(label => HOST_LABEL.test(label))
    && !/^\d+$/u.test(labels.at(-1) ?? '')
    && !/(?:^|\.)(?:local|localhost|localdomain)$/u.test(url.hostname)
}

function publicDestination(value: unknown, origin: string): value is string {
  if (typeof value !== 'string' || value.trim() !== value || !/^[\x21-\x7e]+$/u.test(value)
    || /[?#\\]/u.test(value) || !value.startsWith(`${origin}/`)) return false
  let url: URL
  try { url = new URL(value) }
  catch { return false }
  return url.protocol === 'https:' && url.username === '' && url.password === ''
    && url.origin === origin && url.search === '' && url.hash === '' && url.href === value
}

/**
 * Validate the exact no-secret GET response, including an optional shared-chat scope.
 * @param value - untrusted JSON decoded at the authenticated HTTP boundary.
 * @returns validated request metadata, or null for an empty or malformed response.
 */
export function parseBotWebsiteLoginResponse(value: unknown): BotWebsiteLoginRequest | null {
  if (!record(value) || Object.keys(value).length !== 1 || value.request === null) return null
  const request = value.request
  const shared = record(request) && request.scope === 'shared'
  if (!record(request) || Object.keys(request).length !== (shared ? 4 : 3)
    || (request.scope !== undefined && !shared)
    || typeof request.id !== 'string' || !REQUEST_ID.test(request.id)
    || !publicOrigin(request.origin) || !publicDestination(request.destination, request.origin)) return null
  return {
    id: request.id as BotWebsiteLoginRequestId,
    origin: request.origin,
    destination: request.destination,
    ...(shared ? { scope: 'shared' as const } : {}),
  }
}

/**
 * Read one request from the document-relative broker without caching or exposing a value.
 * @param sessionId - exact direct Bot Session selected by the owner.
 * @param signal - cancellation signal for selection changes and disposal.
 * @param fetcher - browser or test HTTP carrier.
 * @returns validated metadata, null for no request or an invalid response.
 */
export async function fetchBotWebsiteLoginRequest(
  sessionId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<BotWebsiteLoginRequest | null> {
  const response = await fetcher(`api/bot-website-login?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
  })
  if (!response.ok) return null
  try { return parseBotWebsiteLoginResponse(await response.json()) }
  catch { return null }
}

/** Inputs for a selected-session request poller. */
export interface BotWebsiteLoginRequestPollerOptions {
  readonly fetcher?: BotWebsiteLoginRequestFetcher
  readonly intervalMs?: number
  readonly onResult: BotWebsiteLoginRequestResult
}

/**
 * Poll metadata for the selected Session.
 * @param options - fetch seam, cadence, and result callback.
 * @returns selection and disposal controls.
 */
export function createBotWebsiteLoginRequestPoller(options: BotWebsiteLoginRequestPollerOptions): BotRequestPoller {
  return createBotRequestPoller(options.fetcher ?? fetchBotWebsiteLoginRequest, options.onResult, options.intervalMs)
}

/**
 * Check the explicit Cloud feature flag before polling the website-login route.
 * @returns whether the current Cloud view enabled saved website-login requests.
 */
export function isBotWebsiteLoginRequestEnabled(): boolean {
  return typeof window !== 'undefined' && window.__YH_BOT_WEBSITE_LOGIN__ === true
}

/** Check the explicit Cloud flag that keeps shared approvals visible while a Bot is idle.
 * @returns whether shared website-login polling is enabled for the current Cloud view.
 */
export function isBotSharedBrowserEnabled(): boolean {
  return typeof window !== 'undefined' && window.__YH_BOT_SHARED_BROWSER__ === true
}

declare global {
  interface Window {
    __YH_BOT_WEBSITE_LOGIN__?: true
    __YH_BOT_SHARED_BROWSER__?: true
  }
}
