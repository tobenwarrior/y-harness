/** Slack Socket Mode transport used by the Bot routine ingress plugin. */

import { Buffer } from 'node:buffer'

const SLACK_CONNECTIONS_OPEN_URL = 'https://slack.com/api/apps.connections.open'
const MAX_CONNECTIONS_OPEN_RESPONSE_BYTES = 16_384
const SOCKET_CLOSE_RECONNECT = 1013
const SOCKET_CLOSE_ERROR = 1011
const SOCKET_CLOSE_DISPOSE = 1000

/** The small WebSocket surface the transport needs from `ws`. */
export interface SlackSocket {
  /** Register a callback for the successful WebSocket handshake. */
  onOpen(listener: () => void): void
  /** Register a callback for one text frame. */
  onMessage(listener: (data: string) => void): void
  /** Register a callback for a closed connection. */
  onClose(listener: () => void): void
  /** Register a callback for a socket error. */
  onError(listener: () => void): void
  /** Send one JSON protocol frame. */
  send(data: string): void
  /** Close the connection with an optional protocol code and reason. */
  close(code?: number, reason?: string): void
}

/** Factory used to open one validated Slack WSS URL. */
export type SlackSocketFactory = (url: string, maxPayloadBytes: number, signal?: AbortSignal) => SlackSocket | Promise<SlackSocket>

/** Fetch subset used for `apps.connections.open`, injectable for local tests. */
export type SlackFetch = (input: string, init?: RequestInit) => Promise<Response>

/** Timer functions used by reconnect backoff; test doubles can keep tests deterministic. */
export interface SlackSocketTimers {
  /** Schedule one callback after a bounded delay. */
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  /** Cancel a callback that has not run. */
  clear(handle: ReturnType<typeof setTimeout>): void
}

/** Sanitized diagnostics sink for transport lifecycle failures. */
export interface SlackSocketLogger {
  /** Record one fixed-message warning without a credential or response body. */
  warn(message: string): void
}

/** Runtime limits and callbacks for one Slack Socket Mode source. */
export interface SlackSocketTransportOptions {
  /** Slack workspace id used to reject envelopes from another installation. */
  workspaceId: string
  /** Slack app id used to reject envelopes from another installation. */
  appId: string
  /** Credential resolver for the app-level token; the value is not retained. */
  resolveToken: () => Promise<string | undefined>
  /** Durable Bot admission callback. */
  accept: (payload: unknown, receivedAt: number) => Promise<void>
  /** Maximum concurrently persisted envelopes. */
  maxConcurrent: number
  /** Maximum envelopes waiting behind active admissions. */
  maxQueued: number
  /** Maximum UTF-8 bytes in one inbound WebSocket frame. */
  maxPayloadBytes: number
  /** Timeout for the `apps.connections.open` request. */
  requestTimeoutMs: number
  /** Timeout for the WebSocket handshake after `ws` is constructed. */
  socketOpenTimeoutMs: number
  /** Initial reconnect delay after a failed connection. */
  reconnectBaseMs: number
  /** Maximum reconnect delay after repeated failures. */
  reconnectMaxMs: number
  /** Maximum time to wait for active admissions during disposal. */
  disposeDrainTimeoutMs: number
  /** Optional fixed-message diagnostics sink. */
  logger?: SlackSocketLogger
  /** Optional request implementation for isolated tests. */
  fetch?: SlackFetch
  /** Optional WebSocket factory for isolated tests. */
  openSocket?: SlackSocketFactory
  /** Optional receipt clock for isolated tests. */
  now?: () => number
  /** Optional timer implementation for isolated tests. */
  timers?: SlackSocketTimers
}

/** Lifecycle exposed by the transport to the Cordis plugin. */
export interface SlackSocketTransport {
  /** Start the first connection attempt; failed attempts are retried in the background. */
  start(): Promise<void>
  /** Stop reconnecting and close the current socket; accepted work is allowed to settle. */
  dispose(): Promise<void>
}

interface SlackSocketState {
  readonly socket: SlackSocket
  opened: boolean
  openTimer: ReturnType<typeof setTimeout> | undefined
}

interface SlackEnvelope {
  readonly envelopeId: string
  readonly type: string | undefined
  readonly payload: Record<string, unknown> | undefined
}

interface PendingEnvelope {
  readonly state: SlackSocketState
  readonly envelopeId: string
  readonly payload: Record<string, unknown>
  readonly receivedAt: number
}

const defaultTimers: SlackSocketTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => { clearTimeout(handle) },
}

/** Read the connection bootstrap response without buffering beyond its limit. */
async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const body = response.body
  if (body === null) return await response.text()
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('Slack Socket Mode URL response is too large')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

/** Open a connection URL through the official Slack endpoint without following redirects. */
async function openConnectionUrl(
  token: string,
  timeoutMs: number,
  fetchImpl: SlackFetch,
  timers: SlackSocketTimers,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const abort = () => { controller.abort() }
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = timers.set(abort, timeoutMs)
  try {
    const response = await fetchImpl(SLACK_CONNECTIONS_OPEN_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('Slack Socket Mode URL request failed')
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && Number(contentLength) > MAX_CONNECTIONS_OPEN_RESPONSE_BYTES) {
      throw new Error('Slack Socket Mode URL response is too large')
    }
    const text = await readBoundedResponse(response, MAX_CONNECTIONS_OPEN_RESPONSE_BYTES)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('Slack Socket Mode URL response is invalid')
    }
    if (!isRecord(parsed) || parsed.ok !== true) throw new Error('Slack Socket Mode URL request was not accepted')
    return validateSlackSocketUrl(parsed.url)
  } finally {
    timers.clear(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

/** Validate that Slack supplied a WSS URL on a Slack-owned origin. */
function validateSlackSocketUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new Error('Slack Socket Mode returned an invalid WSS URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Slack Socket Mode returned an invalid WSS URL')
  }
  const hostname = url.hostname.toLowerCase()
  const slackHost = hostname === 'slack.com' || hostname.endsWith('.slack.com')
  if (url.protocol !== 'wss:' || !slackHost || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new Error('Slack Socket Mode returned an invalid WSS URL')
  }
  return url.href
}

/** Decode a fake or `ws` frame to text without accepting arbitrary objects. */
function frameText(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data) && data.every(item => Buffer.isBuffer(item))) {
    return Buffer.concat(data).toString('utf8')
  }
  return undefined
}

/** Narrow one JSON object received from Slack. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep protocol identifiers bounded and free of control characters. */
function protocolId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined
  for (const character of value) {
    if (character < ' ' || character === '\u007f') return undefined
  }
  return value
}

/** Return the default `ws` adapter only when the plugin actually starts. */
async function openDefaultSocket(url: string, maxPayloadBytes: number, signal?: AbortSignal): Promise<SlackSocket> {
  const { default: WebSocket } = await import('ws')
  const socket = new WebSocket(url, { maxPayload: maxPayloadBytes })
  // `ws` can emit an asynchronous error when CONNECTING is closed. Install a
  // listener before an already-aborted signal can close the socket; the
  // public listener is attached a few lines later by the transport.
  socket.on('error', () => {})
  if (signal?.aborted) socket.close(SOCKET_CLOSE_DISPOSE, 'disposed')
  else signal?.addEventListener('abort', () => { socket.close(SOCKET_CLOSE_DISPOSE, 'disposed') }, { once: true })
  return {
    onOpen: (listener) => { socket.on('open', listener) },
    onMessage: (listener) => {
      socket.on('message', (data) => {
        const text = frameText(data)
        if (text !== undefined) listener(text)
      })
    },
    onClose: (listener) => { socket.on('close', listener) },
    onError: (listener) => { socket.on('error', listener) },
    send: (data) => { socket.send(data) },
    close: (code, reason) => { socket.close(code, reason) },
  }
}

/** Parse one bounded JSON frame without exposing untrusted fields to callers. */
function parseFrame(data: string, maxPayloadBytes: number): Record<string, unknown> | undefined {
  if (Buffer.byteLength(data, 'utf8') > maxPayloadBytes) return undefined
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  return value
}

/** Decode one Socket Mode envelope without exposing untrusted fields to callers. */
function parseEnvelope(value: Record<string, unknown>): SlackEnvelope | undefined {
  const envelopeId = protocolId(value.envelope_id)
  if (envelopeId === undefined) return undefined
  const type = typeof value.type === 'string' ? value.type : undefined
  const payload = isRecord(value.payload) ? value.payload : undefined
  return { envelopeId, type, payload }
}

class SlackSocketTransportImpl implements SlackSocketTransport {
  private readonly options: SlackSocketTransportOptions
  private readonly fetchImpl: SlackFetch
  private readonly openSocket: SlackSocketFactory
  private readonly now: () => number
  private readonly timers: SlackSocketTimers
  private readonly pending: PendingEnvelope[] = []
  private readonly inFlight = new Set<Promise<void>>()
  private active = 0
  private current: SlackSocketState | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private connecting = false
  private disposed = false
  private disposePromise: Promise<void> | undefined
  private connectionAbort: AbortController | undefined

  constructor(options: SlackSocketTransportOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.openSocket = options.openSocket ?? openDefaultSocket
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? defaultTimers
  }

  async start(): Promise<void> {
    await this.connect()
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal()
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true
    this.connectionAbort?.abort()
    this.connectionAbort = undefined
    if (this.reconnectTimer !== undefined) {
      this.timers.clear(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const current = this.current
    this.current = undefined
    if (current !== undefined) {
      if (current.openTimer !== undefined) this.timers.clear(current.openTimer)
      current.opened = false
      try {
        current.socket.close(SOCKET_CLOSE_DISPOSE, 'disposed')
      } catch (_closeError: unknown) {
        // A socket that already closed needs no further cleanup.
      }
    }
    this.pending.length = 0
    await this.waitForAdmissions()
  }

  private async waitForAdmissions(): Promise<void> {
    if (this.inFlight.size === 0) return
    const settled = Promise.all(this.inFlight).then(() => undefined)
    let resolveTimeout!: () => void
    const bounded = new Promise<void>((resolve) => { resolveTimeout = resolve })
    const timeout = this.timers.set(resolveTimeout, this.options.disposeDrainTimeoutMs)
    await Promise.race([settled, bounded])
    this.timers.clear(timeout)
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.connecting || this.current !== undefined) return
    this.connecting = true
    const connectionAbort = new AbortController()
    this.connectionAbort = connectionAbort
    try {
      const token = await this.options.resolveToken()
      if (token === undefined || token.length === 0) {
        this.warn('bot-routine-slack: Slack app token is unavailable; retrying')
        this.scheduleReconnect()
        return
      }
      if (!/^xapp-[\x21-\x7e]{8,}$/u.test(token)) {
        this.warn('bot-routine-slack: Slack app token is malformed; retrying')
        this.scheduleReconnect()
        return
      }
      const url = await openConnectionUrl(token, this.options.requestTimeoutMs, this.fetchImpl, this.timers, connectionAbort.signal)
      const socket = await this.openSocket(url, this.options.maxPayloadBytes, connectionAbort.signal)
      if (connectionAbort.signal.aborted) {
        socket.close(SOCKET_CLOSE_DISPOSE, 'disposed')
        return
      }
      const state: SlackSocketState = { socket, opened: false, openTimer: undefined }
      this.current = state
      state.openTimer = this.timers.set(() => {
        if (this.current === state && !state.opened) {
          this.warn('bot-routine-slack: Slack Socket Mode handshake timed out; retrying')
          this.closeAndReconnect(state, SOCKET_CLOSE_ERROR, 'handshake timeout')
        }
      }, this.options.socketOpenTimeoutMs)
      socket.onOpen(() => {
        if (this.current !== state) return
        state.opened = true
        if (state.openTimer !== undefined) {
          this.timers.clear(state.openTimer)
          state.openTimer = undefined
        }
        this.reconnectAttempt = 0
      })
      socket.onMessage((data) => { this.handleMessage(state, data) })
      socket.onClose(() => { this.handleClose(state) })
      socket.onError(() => { this.handleError(state) })
    } catch {
      if (!connectionAbort.signal.aborted) {
        this.warn('bot-routine-slack: Slack Socket Mode connection failed; retrying')
        this.scheduleReconnect()
      }
    } finally {
      if (this.current === undefined) this.connectionAbort = undefined
      this.connecting = false
    }
  }

  private handleMessage(state: SlackSocketState, data: string): void {
    if (this.current !== state) return
    const frame = parseFrame(data, this.options.maxPayloadBytes)
    if (frame?.type === 'disconnect') {
      this.closeAndReconnect(state, SOCKET_CLOSE_RECONNECT, 'Slack requested reconnect')
      return
    }
    if (frame === undefined) return
    const envelope = parseEnvelope(frame)
    if (envelope === undefined) return
    if (envelope.type !== 'events_api' || envelope.payload === undefined) {
      this.acknowledge(state, envelope.envelopeId)
      return
    }
    if (envelope.payload.team_id !== this.options.workspaceId
      || envelope.payload.api_app_id !== this.options.appId) {
      this.acknowledge(state, envelope.envelopeId)
      return
    }
    if (this.active >= this.options.maxConcurrent && this.pending.length >= this.options.maxQueued) {
      this.restartAfterBackpressure(state)
      return
    }
    const receivedAt = this.now()
    if (!Number.isFinite(receivedAt)) {
      this.restartAfterBackpressure(state)
      return
    }
    this.pending.push({ state, envelopeId: envelope.envelopeId, payload: envelope.payload, receivedAt })
    this.pump()
  }

  private pump(): void {
    while (this.active < this.options.maxConcurrent) {
      const next = this.pending.shift()
      if (next === undefined) return
      this.active += 1
      const task = this.process(next)
      this.inFlight.add(task)
      void task.then(() => { this.inFlight.delete(task) })
    }
  }

  private async process(next: PendingEnvelope): Promise<void> {
    try {
      await this.options.accept(next.payload, next.receivedAt)
      this.acknowledge(next.state, next.envelopeId)
    } catch {
      this.warn('bot-routine-slack: Bot routine admission failed; retrying envelope')
      this.restartAfterFailure(next.state)
    } finally {
      this.active -= 1
      this.pump()
    }
  }

  private acknowledge(state: SlackSocketState, envelopeId: string): void {
    if (this.current !== state || !state.opened) return
    try {
      state.socket.send(JSON.stringify({ envelope_id: envelopeId }))
    } catch {
      this.restartAfterFailure(state)
    }
  }

  private handleClose(state: SlackSocketState): void {
    if (this.current !== state) return
    this.current = undefined
    this.connectionAbort = undefined
    this.pending.length = 0
    if (state.openTimer !== undefined) this.timers.clear(state.openTimer)
    state.openTimer = undefined
    state.opened = false
    this.scheduleReconnect()
  }

  private handleError(state: SlackSocketState): void {
    if (this.current !== state) return
    this.restartAfterFailure(state)
  }

  private restartAfterBackpressure(state: SlackSocketState): void {
    this.closeAndReconnect(state, SOCKET_CLOSE_RECONNECT, 'backpressure')
  }

  private restartAfterFailure(state: SlackSocketState): void {
    this.closeAndReconnect(state, SOCKET_CLOSE_ERROR, 'transport error')
  }

  private closeAndReconnect(state: SlackSocketState, code: number, reason: string): void {
    if (this.current !== state) return
    this.current = undefined
    this.connectionAbort = undefined
    this.pending.length = 0
    if (state.openTimer !== undefined) this.timers.clear(state.openTimer)
    state.openTimer = undefined
    state.opened = false
    try {
      state.socket.close(code, reason)
    } catch (_closeError: unknown) {
      // The close event is not required for reconnect scheduling.
    }
    this.scheduleReconnect()
  }

  private warn(message: string): void {
    this.options.logger?.warn(message)
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const exponent = Math.min(this.reconnectAttempt, 30)
    const delay = Math.min(this.options.reconnectMaxMs, this.options.reconnectBaseMs * 2 ** exponent)
    this.reconnectAttempt += 1
    this.reconnectTimer = this.timers.set(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, delay)
  }
}

/**
 * Create a Slack Socket Mode source with bounded admission and reconnect behavior.
 * @param options - Credentials, handler, and transport limits for one installation.
 * @returns The managed connection and its lifecycle.
 */
export function createSlackSocketTransport(options: SlackSocketTransportOptions): SlackSocketTransport {
  return new SlackSocketTransportImpl(options)
}
