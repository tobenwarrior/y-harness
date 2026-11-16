/** Client for the owner-managed isolated browser broker used by VPS Bots. */

import { createConnection, type Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import type { Branded } from '@yharness/brand'
import type { ComputerAction, ComputerCaptureRunner, VpsComputer } from './computer.ts'
import { validateComputerAction, VpsComputer as ComputerHost } from './computer.ts'

const SOCKET_TIMEOUT_MS = 30_000
const POLICY_PROBE_MS = 3_000
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024
const MAX_JPEG_BYTES = 2 * 1024 * 1024
const URL_MAX_BYTES = 4_096
const LOGIN_METADATA_MAX_BYTES = 4_096
const LOGIN_ID_MAX_BYTES = 256
const LOGIN_ID = /^[0-9a-f]{32}$/u
const LOGIN_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

const UNAUTHORIZED = 'This Bot is not authorized for the isolated browser.'
const ABORTED = 'The isolated browser request was cancelled.'
const TIMED_OUT = 'The isolated browser request timed out.'
const UNAVAILABLE = 'The isolated browser is unavailable.'
const INVALID_RESPONSE = 'The isolated browser response was invalid.'
const INVALID_URL = 'The isolated browser URL is invalid.'
const COMPUTER_DISPLAY = ':isolated-browser'
const COMPUTER_AUTHORITY = '/dev/null'
const MANAGED_BROWSER_CONTROL = '/run/yharness-browser/control.sock'

/** Trusted Web Host configuration for one isolated browser broker socket. */
export interface VpsIsolatedBrowserConfig {
  /** Absolute Unix-domain socket path owned by the Cloud browser service. */
  readonly socketPath: string
  /** Exact Bot roster ids allowed to use the browser service. */
  readonly bots: string[]
  /** Bot roster ids also allowed to use separate browsers in their shared chats. */
  readonly sharedBots?: string[]
  /** Whether the owner-approved saved-login flow is available to these Bots. */
  readonly savedLogins?: boolean
}

/** Deterministic socket seam used by Host tests. */
export interface VpsIsolatedBrowserInternals {
  /** Open one Unix-domain socket connection. */
  readonly connect?: (options: { readonly path: string }) => Socket
}

interface StatusResponse {
  readonly available: true
}

interface AckResponse {
  readonly ok: true
}

interface BrowserSharingStatus {
  readonly managed: boolean
  readonly legacy: boolean
  readonly override: boolean | null
}

/** Effective shared-browser permission and its eligibility for the owner controls. */
export interface VpsBrowserSharingPolicy {
  readonly managed: boolean
  readonly enabled: boolean
}

/** Metadata shown only to the authenticated owner while a saved login is pending. */
export interface VpsBrowserLoginRequest {
  /** Opaque broker request identifier. */
  readonly id: string
  /** Website origin selected by the Bot's saved-login request. */
  readonly origin: string
  /** Exact same-origin website POST URL for the saved-login approval. */
  readonly destination: string
  /** The only creation state accepted from the broker. */
  readonly state: 'pending'
}

/** State returned by saved-login status and cancellation operations. */
export type VpsBrowserLoginState = 'pending' | 'submitted' | 'needs-owner' | 'unavailable'

/** Worker challenge issued when the owner approves a shared sign-in. */
export interface VpsBrowserApprovalChallenge {
  readonly state: 'approval-pending'
  readonly challenge: string
}

/** Validate current shared access and start work inside its authority check. */
export type VpsBrowserAdmission = (signal: AbortSignal, start?: () => void) => Promise<boolean>

/** Private worker lease used only by the Web Host that requested the handoff. */
export type VpsBrowserHandoffLease = Branded<'VpsBrowserHandoffLease'>

/** Exact shared browser and its private worker lease. */
export interface VpsBrowserHandoff {
  readonly bot: string
  readonly session: string
  readonly lease: VpsBrowserHandoffLease
}

type Request =
  | { readonly action: 'status' | 'frame' | 'sharing-status'; readonly bot: string; readonly session: string }
  | { readonly action: 'status'; readonly bot: string; readonly session: string; readonly capability: 'restart' }
  | { readonly action: 'restart'; readonly bot: string; readonly session: string }
  | { readonly action: 'input'; readonly bot: string; readonly session: string; readonly input: ComputerAction }
  | { readonly action: 'navigate'; readonly bot: string; readonly session: string; readonly url: string }
  | { readonly action: 'request-login'; readonly bot: string; readonly session: string }
  | { readonly action: 'login-status' | 'cancel-login'; readonly bot: string; readonly session: string; readonly id: string }
  | { readonly action: 'authorize-login'; readonly bot: string; readonly session: string; readonly id: string; readonly challenge: string }
  | (VpsBrowserHandoff & { readonly action: 'begin-handoff' | 'frame' })
  | (VpsBrowserHandoff & { readonly action: 'end-handoff'; readonly outcome: 'complete' | 'discard' })
  | (VpsBrowserHandoff & { readonly action: 'input'; readonly origin: string; readonly input: ComputerAction })
  | (VpsBrowserHandoff & { readonly action: 'navigate'; readonly url: string })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateConfig(config: VpsIsolatedBrowserConfig): void {
  if (!isAbsolute(config.socketPath) || config.socketPath.includes('\u0000')) {
    throw new TypeError('VPS isolated browser socketPath must be absolute.')
  }
  if (config.bots.length === 0 || config.bots.some(bot => typeof bot !== 'string' || bot.length === 0 || bot.includes('\u0000'))) {
    throw new TypeError('VPS isolated browser bots must contain at least one valid Bot id.')
  }
  if (new Set(config.bots).size !== config.bots.length) {
    throw new TypeError('VPS isolated browser bots must be unique.')
  }
  if (config.sharedBots !== undefined) {
    if (new Set(config.sharedBots).size !== config.sharedBots.length) {
      throw new TypeError('VPS shared browser Bots must be unique.')
    }
    if (config.sharedBots.some(bot => !config.bots.includes(bot))) {
      throw new TypeError('VPS shared browser Bots must select already isolated browser Bots.')
    }
  }
}

/**
 * Classify the Session namespace used for collaborator browser access.
 * @param session - Server-owned Session id.
 * @returns Whether it belongs to the shared Session namespace.
 */
export function isSharedBrowserSession(session: string): boolean {
  return session.startsWith('shared-session-')
}

function decodeJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error(INVALID_RESPONSE)
  }
}

function decodeStatus(value: unknown): StatusResponse {
  if (isRecord(value) && value.available === true) return { available: true }
  throw new Error(INVALID_RESPONSE)
}

function decodeRestart(value: unknown): 'restarted' | 'busy' {
  if (isRecord(value) && Object.keys(value).length === 1 && (value.status === 'restarted' || value.status === 'busy')) return value.status
  throw new Error(INVALID_RESPONSE)
}

function decodeSharingStatus(value: unknown): BrowserSharingStatus {
  if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.managed !== 'boolean'
    || typeof value.legacy !== 'boolean' || (value.override !== null && typeof value.override !== 'boolean')
    || (!value.managed && value.override !== null)) throw new Error(INVALID_RESPONSE)
  return { managed: value.managed, legacy: value.legacy, override: value.override }
}

function decodeAck(value: unknown): AckResponse {
  if (isRecord(value) && value.ok === true) return { ok: true }
  throw new Error(INVALID_RESPONSE)
}

function metadataString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function loginMetadata(originValue: unknown, destinationValue: unknown): Pick<VpsBrowserLoginRequest, 'origin' | 'destination'> | undefined {
  if (!metadataString(originValue, LOGIN_METADATA_MAX_BYTES) || !metadataString(destinationValue, LOGIN_METADATA_MAX_BYTES)) {
    return undefined
  }
  try {
    const normalizedOrigin = validateIsolatedBrowserUrl(originValue)
    const normalizedDestination = validateIsolatedBrowserUrl(destinationValue)
    const originUrl = new URL(normalizedOrigin)
    const destinationUrl = new URL(normalizedDestination)
    const labels = originUrl.hostname.split('.')
    if (originUrl.origin !== originValue || normalizedDestination !== destinationValue
      || originUrl.protocol !== 'https:' || originUrl.pathname !== '/' || originUrl.search !== '' || originUrl.hash !== ''
      || destinationUrl.protocol !== 'https:' || destinationUrl.origin !== originUrl.origin
      || destinationUrl.search !== '' || destinationUrl.hash !== ''
      || !destinationValue.startsWith(originUrl.origin + '/') || destinationValue.includes('?') || destinationValue.includes('#')
      || labels.length < 2 || labels.some(label => !LOGIN_HOST_LABEL.test(label))
      || /^\d+$/u.test(labels.at(-1) ?? '') || /(?:^|\.)(?:local|localhost|localdomain)$/u.test(originUrl.hostname)) {
      return undefined
    }
    return { origin: originValue, destination: destinationValue }
  } catch {
    return undefined
  }
}

function decodeLoginRequest(value: unknown): VpsBrowserLoginRequest {
  const metadata = isRecord(value) ? loginMetadata(value.origin, value.destination) : undefined
  if (!isRecord(value) || Object.keys(value).length !== 4 || value.state !== 'pending'
    || !metadataString(value.id, LOGIN_ID_MAX_BYTES) || !LOGIN_ID.test(value.id)
    || metadata === undefined) {
    throw new Error(INVALID_RESPONSE)
  }
  return { id: value.id, origin: metadata.origin, destination: metadata.destination, state: 'pending' }
}

function decodeLoginState(value: unknown): VpsBrowserLoginState {
  if (!isRecord(value) || Object.keys(value).length !== 1
    || (value.state !== 'pending' && value.state !== 'submitted' && value.state !== 'needs-owner' && value.state !== 'unavailable')) {
    throw new Error(INVALID_RESPONSE)
  }
  return value.state
}

function decodeLoginStatus(value: unknown): VpsBrowserLoginState | VpsBrowserApprovalChallenge {
  if (isRecord(value) && Object.keys(value).length === 2 && value.state === 'approval-pending'
    && typeof value.challenge === 'string' && LOGIN_ID.test(value.challenge)) {
    return { state: value.state, challenge: value.challenge }
  }
  return decodeLoginState(value)
}

function decodeFrame(value: unknown): Buffer {
  if (!isRecord(value) || value.width !== 1280 || value.height !== 800 || typeof value.jpeg !== 'string') {
    throw new Error(INVALID_RESPONSE)
  }
  const encoded = value.jpeg
  const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
  if (encoded.length === 0 || !base64.test(encoded)) {
    throw new Error(INVALID_RESPONSE)
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > MAX_JPEG_BYTES || bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(INVALID_RESPONSE)
  }
  return bytes
}

function handoffOrigin(value: unknown): string {
  if (!metadataString(value, URL_MAX_BYTES)) throw new Error(INVALID_RESPONSE)
  const url = new URL(validateUrl(value))
  if (url.protocol !== 'https:' || url.origin !== value) throw new Error(INVALID_RESPONSE)
  return value
}

function decodeHandoffOrigin(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 1) throw new Error(INVALID_RESPONSE)
  return handoffOrigin(value.origin)
}

function decodeHandoffFrame(value: unknown): { readonly bytes: Buffer; readonly browserOrigin: string | null } {
  if (!isRecord(value) || Object.keys(value).length !== 4) throw new Error(INVALID_RESPONSE)
  return { bytes: decodeFrame(value), browserOrigin: value.origin === null ? null : handoffOrigin(value.origin) }
}

function validateSession(session: string): string {
  if (typeof session !== 'string' || session.length === 0 || session.includes('\u0000')) {
    throw new Error(UNAVAILABLE)
  }
  return session
}

function validateUrl(url: string): string {
  if (typeof url !== 'string' || Buffer.byteLength(url, 'utf8') > URL_MAX_BYTES
    || /\s/u.test(url) || /[\u0000-\u001f\u007f]/u.test(url)) {
    throw new Error(INVALID_URL)
  }
  try {
    const parsed = new URL(url)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') {
      throw new Error(INVALID_URL)
    }
    return parsed.href
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_URL) throw error
    throw new Error(INVALID_URL)
  }
}

function safeSocketError(error: unknown): Error {
  if (error instanceof Error && [ABORTED, TIMED_OUT, UNAVAILABLE, INVALID_RESPONSE].includes(error.message)) return error
  return new Error(UNAVAILABLE)
}

/**
 * Start a shared browser operation at the current authority check and await it outside the lock.
 * @param authorized - Exact Session's admission check.
 * @param operation - Browser socket operation to start.
 * @param signal - Calling turn cancellation.
 * @returns The admitted operation's result.
 */
export async function runAuthorizedBrowserOperation<T>(
  authorized: VpsBrowserAdmission, operation: () => Promise<T>, signal: AbortSignal,
): Promise<T> {
  let started: Promise<T> | undefined
  try {
    const allowed = await authorized(signal, () => {
      signal.throwIfAborted()
      started = operation()
      void started.catch(() => undefined)
    })
    if (!allowed || started === undefined) throw new Error('The shared browser is unavailable for this chat.')
    return await started
  } catch (error) {
    await started?.catch(() => undefined)
    throw error
  }
}

/** Host-side client for one configured isolated browser broker. */
export class VpsIsolatedBrowser {
  private readonly socketPath: string
  private readonly bots: ReadonlySet<string>
  private readonly sharedBots: ReadonlySet<string>
  private readonly connect: (options: { readonly path: string }) => Socket

  /**
   * @param config - Trusted deployment configuration; model input cannot select its values.
   * @param internals - Optional socket seam used by tests.
   */
  constructor(config: VpsIsolatedBrowserConfig, internals: VpsIsolatedBrowserInternals = {}) {
    validateConfig(config)
    this.socketPath = config.socketPath
    this.bots = new Set(config.bots)
    this.sharedBots = new Set(config.sharedBots)
    this.connect = internals.connect ?? createConnection
  }

  /**
   * Check whether the Cloud configuration selects the Bot for this provider.
   * @param bot - Bot roster id.
   * @param session - If supplied, verify the Session's browser scope.
   * @returns Whether the Bot is eligible for a broker request. Shared turns also check their effective policy.
   */
  authorized(bot: string, session?: string): boolean {
    return session !== undefined && isSharedBrowserSession(session)
      ? this.sharedBots.has(bot) || (this.usesManagedSharing() && this.bots.has(bot)) : this.bots.has(bot)
  }

  /**
   * Identify the installed worker eligible for management through the owner's Vault.
   * @returns Whether this profile uses the installed browser worker socket.
   */
  usesManagedSharing(): boolean {
    return this.socketPath === MANAGED_BROWSER_CONTROL
  }

  /** Read the effective shared selection for the exact owner Bot Session.
   * @param bot - Configured isolated browser Bot.
   * @param ownerSession - Canonical Bot owner Session.
   * @param signal - Cancellation for the read-only broker request.
   * @returns Whether the owner can manage the selection and whether shared browsing is enabled.
   */
  async sharingPolicy(bot: string, ownerSession: string, signal: AbortSignal): Promise<VpsBrowserSharingPolicy> {
    if (!this.usesManagedSharing() || isSharedBrowserSession(ownerSession)) throw new Error(UNAUTHORIZED)
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(POLICY_PROBE_MS)])
    const policy = await this.request({
      action: 'sharing-status', bot, session: validateSession(ownerSession),
    }, decodeSharingStatus, bounded)
    return { managed: policy.managed, enabled: policy.override ?? (policy.legacy && this.sharedBots.has(bot)) }
  }

  /** Resolve one shared chat's permission without launching its browser.
   * @param bot - Configured isolated browser Bot.
   * @param session - Calling private or group shared Session.
   * @param ownerSession - Canonical Bot owner Session when available.
   * @param signal - Cancellation owned by the prompt or tool operation.
   * @returns Whether the current browser policy admits the exact shared chat.
   */
  async availableInSharedSession(bot: string, session: string, ownerSession: string | undefined, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !isSharedBrowserSession(session) || !this.authorized(bot, session)) return false
    if (!this.usesManagedSharing()) return true
    if (ownerSession !== undefined) {
      try {
        return (await this.sharingPolicy(bot, ownerSession, signal)).enabled
      } catch (error) {
        // Older installed workers reply on the original shared-session status route.
        void error
      }
    }
    if (signal.aborted || !this.sharedBots.has(bot)) return false
    try {
      await this.status(bot, session, AbortSignal.any([signal, AbortSignal.timeout(POLICY_PROBE_MS)]))
      return true
    } catch (error) {
      void error
      return false
    }
  }

  /**
   * Ask the broker whether the selected browser is available.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param signal - Calling turn cancellation signal.
   * @returns The broker's positive availability response.
   */
  async status(bot: string, session: string, signal: AbortSignal): Promise<StatusResponse> {
    return this.request({ action: 'status', bot, session: validateSession(session) }, decodeStatus, signal)
  }

  /**
   * Check support for reopening a private browser without launching a page.
   * @param bot - Exact Bot roster id.
   * @param session - Canonical owner Session id.
   * @param signal - Status request cancellation.
   * @returns Whether the installed worker offers recovery for the selected Bot.
   */
  async restartAvailable(bot: string, session: string, signal: AbortSignal): Promise<boolean> {
    if (isSharedBrowserSession(session)) return false
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(POLICY_PROBE_MS)])
    try {
      await this.request({ action: 'status', bot, session: validateSession(session), capability: 'restart' }, decodeStatus, bounded)
      return true
    } catch (error) {
      void error
      return false
    }
  }

  /**
   * Close the selected idle browser so the next frame opens its saved profile.
   * @param bot - Exact Bot roster id.
   * @param session - Canonical owner Session id.
   * @param signal - Cancellation for this restart request.
   * @returns Whether the private browser closed or is in use.
   */
  async restart(bot: string, session: string, signal: AbortSignal): Promise<'restarted' | 'busy'> {
    if (isSharedBrowserSession(session)) throw new Error(UNAUTHORIZED)
    return this.request({ action: 'restart', bot, session: validateSession(session) }, decodeRestart, signal)
  }

  /**
   * Capture one broker-owned JPEG frame.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param signal - Calling turn cancellation signal.
   * @returns JPEG bytes from the fixed 1280×800 browser display.
   */
  async frame(bot: string, session: string, signal: AbortSignal): Promise<Buffer> {
    return this.request({ action: 'frame', bot, session: validateSession(session) }, decodeFrame, signal)
  }

  /**
   * Send one lease-admitted Computer action to the broker.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param input - Already bounded Computer action.
   * @param signal - Calling turn cancellation signal.
   * @returns When the broker acknowledges the action.
   */
  async input(bot: string, session: string, input: ComputerAction, signal: AbortSignal): Promise<void> {
    const normalized = validateComputerAction(input)
    await this.request({ action: 'input', bot, session: validateSession(session), input: normalized }, decodeAck, signal)
  }

  /**
   * Navigate the selected isolated browser without exposing credentials to the model.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param url - HTTP(S) URL without embedded credentials.
   * @param signal - Calling turn cancellation signal.
   * @returns When the broker acknowledges navigation.
   */
  async navigate(bot: string, session: string, url: string, signal: AbortSignal): Promise<void> {
    const validatedUrl = validateUrl(url)
    await this.request({ action: 'navigate', bot, session: validateSession(session), url: validatedUrl }, decodeAck, signal)
  }

  /**
   * Ask the broker to create one owner-approved saved-login request.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param signal - Calling turn cancellation signal.
   * @returns Pending owner-only request metadata.
   */
  async requestLogin(bot: string, session: string, signal: AbortSignal): Promise<VpsBrowserLoginRequest> {
    return this.request({ action: 'request-login', bot, session: validateSession(session) }, decodeLoginRequest, signal)
  }

  /**
   * Read one saved-login request state without exposing broker diagnostics.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param id - Broker request identifier.
   * @param signal - Calling turn cancellation signal.
   * @returns Current request state.
   */
  async loginStatus(
    bot: string,
    session: string,
    id: string,
    signal: AbortSignal,
  ): Promise<VpsBrowserLoginState | VpsBrowserApprovalChallenge> {
    if (!metadataString(id, LOGIN_ID_MAX_BYTES) || !LOGIN_ID.test(id)) throw new Error(INVALID_RESPONSE)
    return this.request({ action: 'login-status', bot, session: validateSession(session), id }, decodeLoginStatus, signal)
  }

  /**
   * Release the broker's pending shared sign-in after the Host rechecks membership.
   * @param bot - Authorized Bot roster id.
   * @param session - Exact admitted shared Session.
   * @param id - Broker login request identifier.
   * @param challenge - Single-use approval challenge from the broker.
   * @param signal - Caller cancellation.
   * @returns When the browser acknowledges the approval.
   */
  async authorizeLogin(bot: string, session: string, id: string, challenge: string, signal: AbortSignal): Promise<void> {
    if (!LOGIN_ID.test(id) || !LOGIN_ID.test(challenge) || !isSharedBrowserSession(session)) throw new Error(INVALID_RESPONSE)
    await this.request({ action: 'authorize-login', bot, session, id, challenge }, decodeAck, signal)
  }

  /**
   * Cancel one pending saved-login request.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param id - Broker request identifier.
   * @param signal - Cancellation for this cleanup exchange.
   * @returns Broker's resulting request state.
   */
  async cancelLogin(bot: string, session: string, id: string, signal: AbortSignal): Promise<VpsBrowserLoginState> {
    if (!metadataString(id, LOGIN_ID_MAX_BYTES) || !LOGIN_ID.test(id)) throw new Error(INVALID_RESPONSE)
    return this.request({ action: 'cancel-login', bot, session: validateSession(session), id }, decodeLoginState, signal)
  }

  /** Reserve the current shared browsing page before exposing the request to the owner.
   * @param handoff - Exact shared profile and private lease.
   * @param signal - Calling turn cancellation.
   * @returns The canonical origin of the current HTTPS page.
   */
  async beginHandoff(handoff: VpsBrowserHandoff, signal: AbortSignal): Promise<string> {
    if (!isSharedBrowserSession(handoff.session)) throw new Error(UNAUTHORIZED)
    return this.request({ ...handoff, action: 'begin-handoff' }, decodeHandoffOrigin, signal)
  }

  /** Return an owner-confirmed page to the model or close the interrupted page.
   * @param handoff - Exact shared profile and private lease.
   * @param outcome - Complete the handoff or discard the live page.
   * @param signal - Request deadline and cancellation.
   * @returns When the worker acknowledges the exact lease transition.
   */
  async endHandoff(handoff: VpsBrowserHandoff, outcome: 'complete' | 'discard', signal: AbortSignal): Promise<void> {
    await this.request({ ...handoff, action: 'end-handoff', outcome }, decodeAck, signal)
  }

  /** Navigate the shared browser while the owner holds it.
   * @param handoff - Exact shared profile and private lease.
   * @param url - HTTPS website address entered by the owner.
   * @param signal - Request cancellation.
   * @returns When the worker acknowledges navigation.
   */
  async navigateHandoff(handoff: VpsBrowserHandoff, url: string, signal: AbortSignal): Promise<void> {
    const validated = validateUrl(url)
    if (!validated.startsWith('https://')) throw new Error(INVALID_URL)
    await this.request({ ...handoff, action: 'navigate', url: validated }, decodeAck, signal)
  }

  /** Build the owner controller that uses only the worker's temporary handoff lease.
   * @param handoff - Exact shared profile and private lease.
   * @param authorize - Fresh admission for the shared turn.
   * @param lifetime - Aborts when the handoff stops accepting owner input.
   * @returns Private viewer controls for the leased page.
   */
  handoffComputer(handoff: VpsBrowserHandoff, authorize: VpsBrowserAdmission, lifetime: AbortSignal): VpsComputer {
    const capture: ComputerCaptureRunner = (signal) => {
      const bounded = AbortSignal.any([lifetime, signal])
      return runAuthorizedBrowserOperation(authorize,
        () => this.request({ ...handoff, action: 'frame' }, decodeHandoffFrame, bounded), bounded)
    }
    return new ComputerHost({ display: COMPUTER_DISPLAY, authorityPath: COMPUTER_AUTHORITY }, {
      capture,
      input: async (action, signal, origin) => {
        const bounded = AbortSignal.any([lifetime, signal])
        const expected = handoffOrigin(origin)
        await runAuthorizedBrowserOperation(authorize, () => this.request({
          ...handoff, action: 'input', origin: expected, input: action,
        }, decodeAck, bounded), bounded)
      },
    })
  }

  /**
   * Construct a Computer controller backed entirely by this broker.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param authorize - Optional fresh admission after the Computer queue releases.
   * @returns A controller whose frame and input operations never invoke Podman or a shell.
   */
  computer(bot: string, session: string, authorize?: VpsBrowserAdmission): VpsComputer {
    if (!this.authorized(bot, session)) throw new Error(UNAUTHORIZED)
    validateSession(session)
    const run = <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => authorize === undefined
      ? operation() : runAuthorizedBrowserOperation(authorize, operation, signal)
    const capture: ComputerCaptureRunner = signal => run(() => this.frame(bot, session, signal), signal)
    return new ComputerHost({ display: COMPUTER_DISPLAY, authorityPath: COMPUTER_AUTHORITY }, {
      capture,
      input: (action, signal) => run(() => this.input(bot, session, action, signal), signal),
    })
  }

  private async request<T>(request: Request, decode: (value: unknown) => T, signal: AbortSignal): Promise<T> {
    if (!this.authorized(request.bot, request.session)) throw new Error(UNAUTHORIZED)
    if (signal.aborted) throw new Error(ABORTED)
    const body = Buffer.from(JSON.stringify(request), 'utf8')
    if (body.byteLength > MAX_REQUEST_BYTES) throw new Error(INVALID_RESPONSE)
    return await new Promise<T>((resolve, reject) => {
      let socket: Socket | undefined
      let settled = false
      let receivedBytes = 0
      const chunks: Buffer[] = []
      const finish = (result: { value: T } | { error: Error }): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        signal.removeEventListener('abort', onAbort)
        socket?.destroy()
        if ('error' in result) reject(result.error)
        else resolve(result.value)
      }
      const onAbort = (): void => { finish({ error: new Error(ABORTED) }) }
      const onData = (chunk: Buffer): void => {
        receivedBytes += chunk.byteLength
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          finish({ error: new Error(INVALID_RESPONSE) })
          return
        }
        chunks.push(chunk)
      }
      const onEnd = (): void => {
        if (receivedBytes === 0) {
          finish({ error: new Error(UNAVAILABLE) })
          return
        }
        try {
          finish({ value: decode(decodeJson(Buffer.concat(chunks, receivedBytes))) })
        } catch (error) {
          finish({ error: safeSocketError(error) })
        }
      }
      const deadline = setTimeout(() => finish({ error: new Error(TIMED_OUT) }), SOCKET_TIMEOUT_MS)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        socket = this.connect({ path: this.socketPath })
        socket.once('connect', () => { socket?.end(body) })
        socket.on('data', onData)
        socket.once('end', onEnd)
        socket.once('close', () => finish({ error: new Error(UNAVAILABLE) }))
        socket.once('error', error => finish({ error: safeSocketError(error) }))
      } catch (error) {
        finish({ error: safeSocketError(error) })
      }
    })
  }
}

/**
 * Validate a navigation URL before it reaches the broker.
 * @param url - Untrusted URL entered by the viewer or Bot.
 * @returns Canonical HTTP(S) URL without user information.
 */
export function validateIsolatedBrowserUrl(url: string): string {
  return validateUrl(url)
}
