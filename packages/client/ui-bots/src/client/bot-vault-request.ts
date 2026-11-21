/** Browser-side metadata reader for the owner Bot's write-only Vault request. */

import type { Branded } from '@yharness/brand'
import { createBotRequestPoller, type BotRequestPoller } from './bot-request-poller.ts'

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
  readonly scope?: 'shared'
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
  const shared = record(request) && request.scope === 'shared'
  if (!record(request) || Object.keys(request).length !== (shared ? 5 : 4)
    || (request.scope !== undefined && !shared)) return null
  if (!requestId(request.id) || !unitName(request.unit) || !keyName(request.name) || !requestState(request.state)) return null
  return {
    id: request.id,
    unit: request.unit,
    name: request.name,
    state: request.state,
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
export async function fetchBotVaultRequest(
  sessionId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<BotVaultRequest | null> {
  const response = await fetcher(`api/bot-vault-request?sessionId=${encodeURIComponent(sessionId)}`, {
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
 * Poll metadata for the selected Session.
 * @param options - fetch seam, cadence, and result callback.
 * @returns selection and disposal controls.
 */
export function createBotVaultRequestPoller(options: BotVaultRequestPollerOptions): BotRequestPoller {
  return createBotRequestPoller(options.fetcher ?? fetchBotVaultRequest, options.onResult, options.intervalMs)
}

/**
 * Recognize the native Cloud view's request handoff.
 * @param userAgent - User-Agent from the active browser.
 * @returns Whether it contains the exact supported Desktop token.
 */
export function isYHarnessCloudDesktop(userAgent: string): boolean {
  return userAgent.split(/\s+/u).includes('YHarnessCloudDesktop/1')
}
