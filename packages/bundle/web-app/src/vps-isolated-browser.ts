/** Client for the owner-managed isolated browser broker used by VPS Bots. */

import { createConnection, type Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import type { ComputerAction, ComputerCaptureRunner, VpsComputer } from './computer.ts'
import { validateComputerAction, VpsComputer as ComputerHost } from './computer.ts'

const SOCKET_TIMEOUT_MS = 30_000
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024
const MAX_JPEG_BYTES = 2 * 1024 * 1024
const URL_MAX_BYTES = 4_096

const UNAUTHORIZED = 'This Bot is not authorized for the isolated browser.'
const ABORTED = 'The isolated browser request was cancelled.'
const TIMED_OUT = 'The isolated browser request timed out.'
const UNAVAILABLE = 'The isolated browser is unavailable.'
const INVALID_RESPONSE = 'The isolated browser response was invalid.'
const INVALID_URL = 'The isolated browser URL is invalid.'
const COMPUTER_DISPLAY = ':isolated-browser'
const COMPUTER_AUTHORITY = '/dev/null'

/** Trusted Web Host configuration for one isolated browser broker socket. */
export interface VpsIsolatedBrowserConfig {
  /** Absolute Unix-domain socket path owned by the Cloud browser service. */
  readonly socketPath: string
  /** Exact Bot roster ids allowed to use the browser service. */
  readonly bots: string[]
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

type Request =
  | { readonly action: 'status' | 'frame'; readonly bot: string; readonly session: string }
  | { readonly action: 'input'; readonly bot: string; readonly session: string; readonly input: ComputerAction }
  | { readonly action: 'navigate'; readonly bot: string; readonly session: string; readonly url: string }

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

function decodeAck(value: unknown): AckResponse {
  if (isRecord(value) && value.ok === true) return { ok: true }
  throw new Error(INVALID_RESPONSE)
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

/** Host-side client for one configured isolated browser broker. */
export class VpsIsolatedBrowser {
  private readonly socketPath: string
  private readonly bots: ReadonlySet<string>
  private readonly connect: (options: { readonly path: string }) => Socket

  /**
   * @param config - Trusted deployment configuration; model input cannot select its values.
   * @param internals - Optional socket seam used by tests.
   */
  constructor(config: VpsIsolatedBrowserConfig, internals: VpsIsolatedBrowserInternals = {}) {
    validateConfig(config)
    this.socketPath = config.socketPath
    this.bots = new Set(config.bots)
    this.connect = internals.connect ?? createConnection
  }

  /**
   * Check whether a Bot is admitted by the owner allowlist.
   * @param bot - Bot roster id.
   * @returns Whether the Bot may use this broker.
   */
  authorized(bot: string): boolean {
    return this.bots.has(bot)
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
   * Construct a Computer controller backed entirely by this broker.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @returns A controller whose frame and input operations never invoke Podman or a shell.
   */
  computer(bot: string, session: string): VpsComputer {
    if (!this.authorized(bot)) throw new Error(UNAUTHORIZED)
    validateSession(session)
    const capture: ComputerCaptureRunner = signal => this.frame(bot, session, signal)
    return new ComputerHost({ display: COMPUTER_DISPLAY, authorityPath: COMPUTER_AUTHORITY }, {
      capture,
      input: (action, signal) => this.input(bot, session, action, signal),
    })
  }

  private async request<T>(request: Request, decode: (value: unknown) => T, signal: AbortSignal): Promise<T> {
    if (!this.authorized(request.bot)) throw new Error(UNAUTHORIZED)
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
