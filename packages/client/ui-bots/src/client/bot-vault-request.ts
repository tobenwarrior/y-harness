/** Browser-side metadata reader for the owner Bot's write-only Vault request. */

import type { Branded } from '@yharness/brand'

/** Opaque identifier issued by the authenticated Cloud Vault broker. */
export type BotVaultRequestId = Branded<'BotVaultRequestId'>

/** States the broker exposes without ever returning a credential value. */
export type BotVaultRequestState = 'pending' | 'saved' | 'cancelled'

/** Validated, non-secret metadata for one Bot Vault request. */
export interface BotVaultRequest {
  readonly id: BotVaultRequestId
  readonly unit: string
  readonly name: string
  readonly state: BotVaultRequestState
}

/** Fetch seam used by the browser reader and lifecycle tests. */
export type BotVaultRequestFetcher = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<BotVaultRequest | null>

/** Result callback for one selected session's validated metadata. */
export type BotVaultRequestResult = (
  sessionId: string,
  request: BotVaultRequest | null,
) => void

/** Poll interval while the selected Bot Session is running. */
const POLL_INTERVAL_MS = 2_000
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service$/u
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const REQUEST_ID = /^[a-f0-9]{32}$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unitName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && UNIT.test(value) && !value.endsWith('@.service')
}

function keyName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && NAME.test(value)
}

function requestId(value: unknown): value is BotVaultRequestId {
  return typeof value === 'string' && REQUEST_ID.test(value)
}

function requestState(value: unknown): value is BotVaultRequestState {
  return value === 'pending' || value === 'saved' || value === 'cancelled'
}

/**
 * Validate the exact no-secret GET response.
 * @param value - untrusted JSON decoded at the authenticated HTTP boundary.
 * @returns validated request metadata, or null for an empty or malformed response.
 */
export function parseBotVaultRequestResponse(value: unknown): BotVaultRequest | null {
  if (!record(value) || Object.keys(value).length !== 1) return null
  const request = value.request
  if (request === null) return null
  if (!record(request) || Object.keys(request).length !== 4) return null
  if (!requestId(request.id) || !unitName(request.unit) || !keyName(request.name) || !requestState(request.state)) return null
  return {
    id: request.id,
    unit: request.unit,
    name: request.name,
    state: request.state,
  }
}

/**
 * Read one request from the same-origin broker without caching or exposing a value.
 * @param sessionId - exact direct Bot Session selected by the owner.
 * @param signal - cancellation signal for selection changes and disposal.
 * @param fetcher - browser or test HTTP carrier.
 * @returns validated metadata, null for no request or an invalid response.
 */
export async function fetchBotVaultRequest(
  sessionId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<BotVaultRequest | null> {
  const response = await fetcher(`/api/bot-vault-request?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) return null
  try {
    return parseBotVaultRequestResponse(await response.json())
  } catch {
    return null
  }
}

/** Inputs for a selected-session request poller. */
export interface BotVaultRequestPollerOptions {
  readonly fetcher?: BotVaultRequestFetcher
  readonly intervalMs?: number
  readonly onResult: BotVaultRequestResult
}

/**
 * Create a stale-safe reader that polls only the currently selected Session.
 * @param options - fetch seam, cadence, and result callback.
 * @returns selection and disposal controls.
 */
export function createBotVaultRequestPoller(options: BotVaultRequestPollerOptions): {
  readonly select: (sessionId: string | undefined, running: boolean) => void
  readonly dispose: () => void
} {
  const fetcher = options.fetcher ?? fetchBotVaultRequest
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
        if (!disposed && currentGeneration === generation && running) {
          timer = setTimeout(() => { void read() }, intervalMs)
        }
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
 * Recognize the native Cloud view's request handoff.
 * @param userAgent - User-Agent from the active browser.
 * @returns Whether it contains the exact supported Desktop token.
 */
export function isYHarnessCloudDesktop(userAgent: string): boolean {
  return userAgent.split(/\s+/u).includes('YHarnessCloudDesktop/1')
}
