/** Browser-side metadata reader for an owner-approved saved website login. */

import type { Branded } from '@yharness/brand'

/** Opaque identifier issued by the authenticated Cloud website-login broker. */
export type BotWebsiteLoginRequestId = Branded<'BotWebsiteLoginRequestId'>

/** Validated, non-secret metadata for one paused website sign-in. */
export interface BotWebsiteLoginRequest {
  readonly id: BotWebsiteLoginRequestId
  readonly origin: string
  readonly destination: string
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

/** Poll interval while the selected Bot Session is running. */
const POLL_INTERVAL_MS = 2_000
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
 * Validate the exact no-secret GET response.
 * @param value - untrusted JSON decoded at the authenticated HTTP boundary.
 * @returns validated request metadata, or null for an empty or malformed response.
 */
export function parseBotWebsiteLoginResponse(value: unknown): BotWebsiteLoginRequest | null {
  if (!record(value) || Object.keys(value).length !== 1 || value.request === null) return null
  const request = value.request
  if (!record(request) || Object.keys(request).length !== 3
    || typeof request.id !== 'string' || !REQUEST_ID.test(request.id)
    || !publicOrigin(request.origin) || !publicDestination(request.destination, request.origin)) return null
  return { id: request.id as BotWebsiteLoginRequestId, origin: request.origin, destination: request.destination }
}

/**
 * Read one request from the same-origin broker without caching or exposing a value.
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
  const response = await fetcher(`/api/bot-website-login?sessionId=${encodeURIComponent(sessionId)}`, {
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
 * Create a stale-safe reader that polls only the currently selected Session.
 * @param options - fetch seam, cadence, and result callback.
 * @returns selection and disposal controls.
 */
export function createBotWebsiteLoginRequestPoller(options: BotWebsiteLoginRequestPollerOptions): {
  readonly select: (sessionId: string | undefined, running: boolean) => void
  readonly dispose: () => void
} {
  const fetcher = options.fetcher ?? fetchBotWebsiteLoginRequest
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let requestController: AbortController | undefined
  let disposed = false

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    requestController?.abort()
    requestController = undefined
  }

  const select = (sessionId: string | undefined, running: boolean): void => {
    cancel()
    const currentGeneration = ++generation
    if (disposed || sessionId === undefined) return
    const read = async (): Promise<void> => {
      const controller = new AbortController()
      requestController = controller
      try {
        const request = await fetcher(sessionId, controller.signal)
        if (disposed || currentGeneration !== generation || controller.signal.aborted) return
        options.onResult(sessionId, request)
      } catch {
        // Network and abort failures leave the last validated card unchanged.
      } finally {
        if (requestController === controller) requestController = undefined
        if (!disposed && currentGeneration === generation && running) timer = setTimeout(() => { void read() }, intervalMs)
      }
    }
    void read()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    ++generation
    cancel()
  }

  return { select, dispose }
}

/**
 * Check the explicit Cloud feature flag before polling the website-login route.
 * @returns whether the current Cloud view enabled saved website-login requests.
 */
export function isBotWebsiteLoginRequestEnabled(): boolean {
  return typeof window !== 'undefined' && window.__YH_BOT_WEBSITE_LOGIN__ === true
}

declare global {
  interface Window {
    __YH_BOT_WEBSITE_LOGIN__?: true
  }
}
