import { Context } from '@yharness/cordis'
import { expect, it, vi } from 'vitest'
import type { SlackSocket, SlackSocketTimers, SlackSocketTransportOptions } from '../src/slack-socket.ts'
import { createSlackSocketTransport } from '../src/slack-socket.ts'
import { apply, Config, mountSlackRoutineSource } from '../src/routine-slack.ts'

const wsMock = vi.hoisted(() => {
  class MockWebSocket {
    static readonly instances: MockWebSocket[] = []
    readonly sent: string[] = []
    readonly closed: Array<{ code: number | undefined; reason: string | undefined }> = []
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    readonly url: string
    readonly options: unknown
    private readyState = 0

    constructor(url: string, options: unknown) {
      this.url = url
      this.options = options
      MockWebSocket.instances.push(this)
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    send(data: string): void { this.sent.push(data) }

    close(code?: number, reason?: string): void {
      this.closed.push({ code, reason })
      if (this.readyState === 0) {
        this.readyState = 2
        queueMicrotask(() => { this.emit('error', new Error('closed while connecting')) })
      }
    }

    open(): void {
      this.readyState = 1
      this.emit('open')
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
  }
  return { MockWebSocket }
})

vi.mock('ws', () => ({ default: wsMock.MockWebSocket }))

class FakeSocket implements SlackSocket {
  readonly sent: string[] = []
  readonly closed: Array<{ code: number | undefined; reason: string | undefined }> = []
  throwOnClose = false
  throwOnSend = false
  private openListener: (() => void) | undefined
  private messageListener: ((data: string) => void) | undefined
  private closeListener: (() => void) | undefined
  private errorListener: (() => void) | undefined

  onOpen(listener: () => void): void { this.openListener = listener }
  onMessage(listener: (data: string) => void): void { this.messageListener = listener }
  onClose(listener: () => void): void { this.closeListener = listener }
  onError(listener: () => void): void { this.errorListener = listener }
  send(data: string): void {
    if (this.throwOnSend) throw new Error('send failed')
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    if (this.throwOnClose) throw new Error('close failed')
    this.closed.push({ code, reason })
  }
  open(): void { this.openListener?.() }
  message(data: unknown): void { this.messageListener?.(JSON.stringify(data)) }
  raw(data: string): void { this.messageListener?.(data) }
  closeFromPeer(): void { this.closeListener?.() }
  fail(): void { this.errorListener?.() }
}

const response = (url: string, status = 200): Response => new Response(
  JSON.stringify({ ok: status === 200, url }),
  { status, headers: { 'content-type': 'application/json' } },
)

const transportOptions = (overrides: Partial<Parameters<typeof createSlackSocketTransport>[0]> = {}) => ({
  workspaceId: 'T123',
  appId: 'A123',
  resolveToken: async () => 'xapp-test-token',
  accept: async () => {},
  maxConcurrent: 2,
  maxQueued: 4,
  maxPayloadBytes: 16_384,
  requestTimeoutMs: 2_000,
  socketOpenTimeoutMs: 2_000,
  reconnectBaseMs: 10,
  reconnectMaxMs: 40,
  disposeDrainTimeoutMs: 2_000,
  ...overrides,
})

const recordingTimers = () => {
  const scheduled: Array<{ callback: () => void; delay: number; handle: ReturnType<typeof setTimeout> }> = []
  const timers: SlackSocketTimers = {
    set: (callback, delay) => {
      const handle = setTimeout(() => {}, 60_000)
      const entry = {
        callback: () => {
          const index = scheduled.indexOf(entry)
          if (index >= 0) scheduled.splice(index, 1)
          callback()
        },
        delay,
        handle,
      }
      scheduled.push(entry)
      return handle
    },
    clear: (handle) => {
      clearTimeout(handle)
      const index = scheduled.findIndex(item => item.handle === handle)
      if (index >= 0) scheduled.splice(index, 1)
    },
  }
  return { timers, scheduled }
}

const mountConfig = () => new Config({ source: 'team-slack', workspaceId: 'T123', appId: 'A123' })

const mountContext = (
  registerSlackRoutineSource: (source: { source: string; workspaceId: string; appId: string }) => {
    accept(payload: unknown, receivedAt: number): Promise<void>
    dispose(): void
  },
  resolve: (reference: string) => Promise<{ value: string } | undefined>,
): Context => {
  const ctx = new Context()
  ctx.provide('bots', { registerSlackRoutineSource } as never)
  ctx.provide('credentials', { resolve } as never)
  return ctx
}

const eventEnvelope = (envelopeId: string, payload: Record<string, unknown> = {}) => ({
  envelope_id: envelopeId,
  type: 'events_api',
  payload: { team_id: 'T123', api_app_id: 'A123', type: 'event_callback', ...payload },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

it('uses the official connections endpoint and ACKs only after durable admission', async () => {
  const socket = new FakeSocket()
  const fetchCalls: Array<{ input: string; init: RequestInit | undefined }> = []
  const accepted: unknown[] = []
  let release!: () => void
  const admitted = new Promise<void>((resolve) => { release = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async (input, init) => {
      fetchCalls.push({ input, init })
      return response('wss://wss-primary.slack.com/link/?ticket=runtime-ticket')
    },
    openSocket: async () => socket,
    accept: async (payload) => { accepted.push(payload); await admitted },
  }))

  await transport.start()
  socket.open()
  socket.message(eventEnvelope('env-1', { event_id: 'Ev123', event: { type: 'message' } }))
  await vi.waitFor(() => { expect(accepted).toHaveLength(1) })
  expect(socket.sent).toHaveLength(0)
  expect(fetchCalls).toHaveLength(1)
  expect(fetchCalls[0]?.input).toBe('https://slack.com/api/apps.connections.open')
  expect(fetchCalls[0]?.init?.redirect).toBe('error')
  expect((fetchCalls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer xapp-test-token')
  expect(JSON.stringify(fetchCalls)).not.toContain('runtime-ticket')

  release()
  await vi.waitFor(() => { expect(socket.sent).toEqual(['{"envelope_id":"env-1"}']) })
  await transport.dispose()
})

it('uses the bounded ws adapter for every supported frame representation', async () => {
  wsMock.MockWebSocket.instances.length = 0
  const accepted: unknown[] = []
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=ws-adapter'),
    accept: async (payload) => { accepted.push(payload) },
  }))
  await transport.start()
  const socket = wsMock.MockWebSocket.instances.at(-1)
  if (socket === undefined) throw new Error('The default ws adapter did not construct a socket')
  expect(socket.url).toBe('wss://wss-primary.slack.com/link/?ticket=ws-adapter')
  expect(socket.options).toEqual({ maxPayload: 16_384 })
  socket.open()
  const frames = [
    JSON.stringify(eventEnvelope('env-string')),
    JSON.stringify(eventEnvelope('env-array-buffer')),
    JSON.stringify(eventEnvelope('env-buffer')),
    JSON.stringify(eventEnvelope('env-buffer-array')),
  ]
  socket.emit('message', frames[0])
  socket.emit('message', Uint8Array.from(Buffer.from(frames[1] ?? '')).buffer)
  socket.emit('message', Buffer.from(frames[2] ?? ''))
  socket.emit('message', [Buffer.from(frames[3] ?? '')])
  socket.emit('message', { unsupported: true })
  await vi.waitFor(() => { expect(accepted).toHaveLength(4) })
  await vi.waitFor(() => { expect(socket.sent).toHaveLength(4) })
  expect(socket.sent.map((value) => {
    const parsed: unknown = JSON.parse(value)
    return parsed
  })).toEqual([
    { envelope_id: 'env-string' },
    { envelope_id: 'env-array-buffer' },
    { envelope_id: 'env-buffer' },
    { envelope_id: 'env-buffer-array' },
  ])
  await transport.dispose()
})

it('installs an error listener before disposing a connecting default ws socket', async () => {
  wsMock.MockWebSocket.instances.length = 0
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=connecting'),
  }))
  await transport.start()
  const socket = wsMock.MockWebSocket.instances.at(-1)
  if (socket === undefined) throw new Error('The default ws adapter did not construct a socket')
  await transport.dispose()
  expect(socket.closed).toContainEqual({ code: 1000, reason: 'disposed' })
  await Promise.resolve()
})

it('turns connection bootstrap failures into bounded sanitized retries', async () => {
  const cases: Array<{ name: string; fetch: () => Promise<Response> }> = [
    { name: 'HTTP failure', fetch: async () => new Response('unavailable', { status: 503 }) },
    { name: 'empty body', fetch: async () => new Response(null, { status: 200 }) },
    { name: 'invalid JSON', fetch: async () => new Response('{', { status: 200 }) },
    { name: 'rejected Slack response', fetch: async () => Response.json({ ok: false }) },
    {
      name: 'oversized content length',
      fetch: async () => new Response('{}', { status: 200, headers: { 'content-length': '16385' } }),
    },
    {
      name: 'oversized streamed body',
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16_385))
          controller.close()
        },
      }), { status: 200 }),
    },
    { name: 'invalid URL value', fetch: async () => Response.json({ ok: true, url: 123 }) },
    { name: 'malformed URL', fetch: async () => Response.json({ ok: true, url: 'not a URL' }) },
    { name: 'insecure URL', fetch: async () => Response.json({ ok: true, url: 'ws://wss-primary.slack.com/socket' }) },
    { name: 'credentialed URL', fetch: async () => Response.json({ ok: true, url: 'wss://token@wss-primary.slack.com/socket' }) },
    { name: 'port URL', fetch: async () => Response.json({ ok: true, url: 'wss://wss-primary.slack.com:8443/socket' }) },
  ]
  for (const testCase of cases) {
    const warn = vi.fn()
    const { timers } = recordingTimers()
    const transport = createSlackSocketTransport(transportOptions({
      fetch: testCase.fetch,
      timers,
      logger: { warn },
    }))
    await transport.start()
    if (warn.mock.calls.length === 0) throw new Error(`No warning for ${testCase.name}`)
    expect(warn).toHaveBeenCalledWith('bot-routine-slack: Slack Socket Mode connection failed; retrying')
    expect(warn.mock.calls.flat().join(' ')).not.toContain(testCase.name)
    await transport.dispose()
  }
})

it('aborts a hanging bootstrap request on its deadline and reconnects', async () => {
  const { timers, scheduled } = recordingTimers()
  const transport = createSlackSocketTransport(transportOptions({
    timers,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
    }),
  }))
  const started = transport.start()
  await vi.waitFor(() => { expect(scheduled.map(item => item.delay)).toContain(2_000) })
  const timeout = scheduled.find(item => item.delay === 2_000)
  if (timeout === undefined) throw new Error('The bootstrap deadline was not scheduled')
  timeout.callback()
  await started
  await transport.dispose()
})

it('rejects a token resolver failure without exposing the failure text', async () => {
  const warn = vi.fn()
  const { timers } = recordingTimers()
  const transport = createSlackSocketTransport(transportOptions({
    timers,
    resolveToken: async () => { throw new Error('private credential resolver failure') },
    logger: { warn },
  }))
  await transport.start()
  expect(warn).toHaveBeenCalledWith('bot-routine-slack: Slack Socket Mode connection failed; retrying')
  expect(warn.mock.calls.flat().join(' ')).not.toContain('private credential')
  await transport.dispose()
})

it('aborts a pending bootstrap request when disposal starts', async () => {
  let fetchStarted = false
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async (_input, init) => await new Promise<Response>((resolve) => {
      fetchStarted = true
      init?.signal?.addEventListener('abort', () => { resolve(response('wss://wss-primary.slack.com/link/?ticket=abort')) }, { once: true })
    }),
  }))
  const started = transport.start()
  await vi.waitFor(() => { expect(fetchStarted).toBe(true) })
  await transport.dispose()
  await started
})

it('suppresses a retry when bootstrap fails after disposal', async () => {
  let rejectFetch!: (reason: Error) => void
  let fetchStarted = false
  const warn = vi.fn()
  const transport = createSlackSocketTransport(transportOptions({
    logger: { warn },
    fetch: async () => await new Promise<Response>((_resolve, reject) => {
      fetchStarted = true
      rejectFetch = reject
    }),
  }))
  const started = transport.start()
  await vi.waitFor(() => { expect(fetchStarted).toBe(true) })
  await transport.dispose()
  rejectFetch(new Error('late bootstrap failure'))
  await started
  expect(warn).not.toHaveBeenCalled()
})

it('passes an already-aborted connection signal through the bootstrap parser', async () => {
  let releaseToken!: (value: string) => void
  const token = new Promise<string>((resolve) => { releaseToken = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    resolveToken: async () => await token,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=pre-aborted'),
  }))
  const started = transport.start()
  await Promise.resolve()
  const disposed = transport.dispose()
  releaseToken('xapp-pre-aborted-token')
  await started
  await disposed
})

it('closes a socket returned after disposal before it can become active', async () => {
  const socket = new FakeSocket()
  let releaseSocket!: (value: SlackSocket) => void
  let opening = false
  const pendingSocket = new Promise<SlackSocket>((resolve) => { releaseSocket = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=late-socket'),
    openSocket: async () => {
      opening = true
      return await pendingSocket
    },
  }))
  const started = transport.start()
  await vi.waitFor(() => { expect(opening).toBe(true) })
  const disposed = transport.dispose()
  releaseSocket(socket)
  await started
  await disposed
  expect(socket.closed).toContainEqual({ code: 1000, reason: 'disposed' })
})

it('uses the injected global fetch when no request implementation is supplied', async () => {
  wsMock.MockWebSocket.instances.length = 0
  const fetch = vi.fn(async () => response('wss://wss-primary.slack.com/link/?ticket=global-fetch'))
  vi.stubGlobal('fetch', fetch)
  try {
    const transport = createSlackSocketTransport(transportOptions())
    await transport.start()
    expect(fetch).toHaveBeenCalledOnce()
    await transport.dispose()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('ignores duplicate starts while connecting, connected, and disposed', async () => {
  const socket = new FakeSocket()
  let releaseToken!: (value: string) => void
  const token = new Promise<string>((resolve) => { releaseToken = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    resolveToken: async () => await token,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=start-guards'),
    openSocket: async () => socket,
  }))
  const first = transport.start()
  await Promise.resolve()
  await transport.start()
  releaseToken('xapp-start-guards-token')
  await first
  await transport.start()
  await transport.dispose()
  await transport.start()
})

it('reconnects after a handshake deadline and survives a close error', async () => {
  const socket = new FakeSocket()
  socket.throwOnClose = true
  const { timers, scheduled } = recordingTimers()
  const warn = vi.fn()
  const fetch = vi.fn(async () => response('wss://wss-primary.slack.com/link/?ticket=handshake'))
  const transport = createSlackSocketTransport(transportOptions({
    timers,
    fetch,
    openSocket: async () => socket,
    logger: { warn },
  }))
  await transport.start()
  const handshake = scheduled.find(item => item.delay === 2_000)
  if (handshake === undefined) throw new Error('The handshake deadline was not scheduled')
  handshake.callback()
  expect(warn).toHaveBeenCalledWith('bot-routine-slack: Slack Socket Mode handshake timed out; retrying')
  const retry = scheduled.find(item => item.delay === 10)
  if (retry === undefined) throw new Error('The reconnect was not scheduled')
  retry.callback()
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
  await transport.dispose()
})

it('ignores a stale handshake deadline after the socket opens', async () => {
  const socket = new FakeSocket()
  const { timers, scheduled } = recordingTimers()
  const transport = createSlackSocketTransport(transportOptions({
    timers,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=handshake-stale'),
    openSocket: async () => socket,
  }))
  await transport.start()
  const handshake = scheduled.find(item => item.delay === 2_000)
  if (handshake === undefined) throw new Error('The handshake deadline was not scheduled')
  socket.open()
  socket.open()
  handshake.callback()
  expect(socket.closed).toHaveLength(0)
  await transport.dispose()
})

it('handles a peer close, stale callbacks, and a socket error', async () => {
  const socket = new FakeSocket()
  const { timers, scheduled } = recordingTimers()
  const transport = createSlackSocketTransport(transportOptions({
    timers,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=close-error'),
    openSocket: async () => socket,
  }))
  await transport.start()
  socket.closeFromPeer()
  socket.open()
  socket.raw(JSON.stringify(eventEnvelope('stale')))
  socket.closeFromPeer()
  const retry = scheduled.find(item => item.delay === 10)
  if (retry === undefined) throw new Error('The reconnect was not scheduled')
  retry.callback()
  await vi.waitFor(() => { expect(scheduled.some(item => item.delay === 2_000)).toBe(true) })
  socket.open()
  socket.fail()
  expect(socket.closed).toContainEqual({ code: 1011, reason: 'transport error' })
  await transport.dispose()
})

it('does not acknowledge an admitted envelope until the socket is open', async () => {
  const socket = new FakeSocket()
  const accepted: unknown[] = []
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=not-open'),
    openSocket: async () => socket,
    accept: async (payload) => { accepted.push(payload) },
  }))
  await transport.start()
  socket.message(eventEnvelope('not-open'))
  await vi.waitFor(() => { expect(accepted).toHaveLength(1) })
  expect(socket.sent).toHaveLength(0)
  await transport.dispose()
})

it('restarts when the clock is invalid or an admission rejects', async () => {
  const socket = new FakeSocket()
  const transport = createSlackSocketTransport(transportOptions({
    now: () => Number.NaN,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=invalid-clock'),
    openSocket: async () => socket,
  }))
  await transport.start()
  socket.open()
  socket.message(eventEnvelope('invalid-clock'))
  expect(socket.closed).toContainEqual({ code: 1013, reason: 'backpressure' })
  await transport.dispose()

  const rejectingSocket = new FakeSocket()
  const warn = vi.fn()
  const rejecting = createSlackSocketTransport(transportOptions({
    logger: { warn },
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=reject'),
    openSocket: async () => rejectingSocket,
    accept: async () => { throw new Error('admission rejected') },
  }))
  await rejecting.start()
  rejectingSocket.open()
  rejectingSocket.message(eventEnvelope('reject'))
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('bot-routine-slack: Bot routine admission failed; retrying envelope') })
  expect(rejectingSocket.closed).toContainEqual({ code: 1011, reason: 'transport error' })
  await rejecting.dispose()
})

it('does not retry a failed admission after its socket has already closed', async () => {
  const socket = new FakeSocket()
  let rejectAdmission!: (reason: Error) => void
  const admission = new Promise<void>((_resolve, reject) => { rejectAdmission = reject })
  const warn = vi.fn()
  const transport = createSlackSocketTransport(transportOptions({
    logger: { warn },
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=stale-admission'),
    openSocket: async () => socket,
    accept: async () => {
      await admission
    },
  }))
  await transport.start()
  socket.open()
  socket.message(eventEnvelope('stale-admission'))
  await vi.waitFor(() => { expect(socket.sent).toHaveLength(0) })
  socket.closeFromPeer()
  rejectAdmission(new Error('late admission failure'))
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('bot-routine-slack: Bot routine admission failed; retrying envelope') })
  await transport.dispose()
})

it('restarts when an acknowledgement send fails and tolerates a throwing close', async () => {
  const socket = new FakeSocket()
  socket.throwOnSend = true
  socket.throwOnClose = true
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=ack-failure'),
    openSocket: async () => socket,
  }))
  await transport.start()
  socket.open()
  socket.message({ envelope_id: 'ack-failure', type: 'hello' })
  expect(socket.closed).toEqual([])
  await vi.waitFor(() => { expect(socket.closed).toHaveLength(0) })
  await transport.dispose()
})

it('bounds disposal while an admission remains in flight and keeps it idempotent', async () => {
  const socket = new FakeSocket()
  let release!: () => void
  const admission = new Promise<void>((resolve) => { release = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    disposeDrainTimeoutMs: 20,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=drain-timeout'),
    openSocket: async () => socket,
    accept: async () => {
      await admission
    },
  }))
  await transport.start()
  socket.open()
  socket.message(eventEnvelope('drain-timeout'))
  await vi.waitFor(() => { expect(socket.sent).toHaveLength(0) })
  const first = transport.dispose()
  const second = transport.dispose()
  await first
  await second
  release()
})

it('ACKs valid protocol envelopes that are not Bot Events API payloads', async () => {
  const socket = new FakeSocket()
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=short-lived'),
    openSocket: async () => socket,
  }))
  await transport.start()
  socket.open()
  socket.message({ envelope_id: 'hello-1', type: 'hello' })
  socket.message({ envelope_id: 'other-app', type: 'events_api', payload: { team_id: 'T999', api_app_id: 'A123' } })
  socket.message({ envelope_id: 'bad-type', payload: {} })
  socket.message({ envelope_id: '\u0000', type: 'hello' })
  socket.message({ envelope_id: '', type: 'hello' })
  socket.message({ envelope_id: 'x'.repeat(257), type: 'hello' })
  socket.raw('{')
  socket.raw('x'.repeat(16_385))
  socket.message('not-an-object')
  expect(socket.sent).toEqual([
    '{"envelope_id":"hello-1"}',
    '{"envelope_id":"other-app"}',
    '{"envelope_id":"bad-type"}',
  ])
  socket.message({ type: 'disconnect', reason: 'warning' })
  expect(socket.closed).toContainEqual({ code: 1013, reason: 'Slack requested reconnect' })
  await transport.dispose()
})

it('does not open an untrusted socket origin and schedules a bounded retry', async () => {
  const socketFactory = vi.fn(async () => new FakeSocket())
  const scheduled: Array<{ callback: () => void; delay: number }> = []
  const timers: SlackSocketTimers = {
    set: (callback, delay) => {
      scheduled.push({ callback, delay })
      return setTimeout(() => {}, 0)
    },
    clear: (handle) => { clearTimeout(handle) },
  }
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://attacker.example/socket'),
    openSocket: socketFactory,
    timers,
  }))
  await transport.start()
  expect(socketFactory).not.toHaveBeenCalled()
  expect(scheduled.map(item => item.delay)).toEqual([2_000, 10])
  await transport.dispose()
})

it('restarts on admission backpressure without acknowledging the overflow', async () => {
  const socket = new FakeSocket()
  let release!: () => void
  const admitted = new Promise<void>((resolve) => { release = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    maxConcurrent: 1,
    maxQueued: 0,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=backpressure'),
    openSocket: async () => socket,
    accept: async () => admitted,
  }))
  await transport.start()
  socket.open()
  socket.message(eventEnvelope('env-1'))
  await vi.waitFor(() => { expect(socket.sent).toHaveLength(0) })
  socket.message(eventEnvelope('env-2'))
  expect(socket.closed).toContainEqual({ code: 1013, reason: 'backpressure' })
  expect(socket.sent).toHaveLength(0)
  release()
  await transport.dispose()
})

it('drops queued envelopes when a socket closes so Slack can redeliver them', async () => {
  const socket = new FakeSocket()
  const accepted: string[] = []
  let release!: () => void
  const admitted = new Promise<void>((resolve) => { release = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    maxConcurrent: 1,
    maxQueued: 1,
    reconnectBaseMs: 1_000,
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=close'),
    openSocket: async () => socket,
    accept: async (payload) => {
      if (isRecord(payload) && typeof payload.event_id === 'string') accepted.push(payload.event_id)
      await admitted
    },
  }))
  await transport.start()
  socket.open()
  socket.message(eventEnvelope('env-1', { event_id: 'one' }))
  await vi.waitFor(() => { expect(accepted).toEqual(['one']) })
  socket.message(eventEnvelope('env-2', { event_id: 'two' }))
  socket.closeFromPeer()
  release()
  await vi.waitFor(() => { expect(socket.sent).toHaveLength(0) })
  expect(accepted).toEqual(['one'])
  await transport.dispose()
})

it('drains an admitted envelope before asynchronous disposal completes', async () => {
  const socket = new FakeSocket()
  let release!: () => void
  const admitted = new Promise<void>((resolve) => { release = resolve })
  const transport = createSlackSocketTransport(transportOptions({
    fetch: async () => response('wss://wss-primary.slack.com/link/?ticket=drain'),
    openSocket: async () => socket,
    accept: async () => admitted,
  }))
  await transport.start()
  socket.open()
  socket.message(eventEnvelope('env-drain'))
  await vi.waitFor(() => { expect(socket.sent).toHaveLength(0) })
  const disposed = transport.dispose()
  let settled = false
  void disposed.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  await disposed
  expect(settled).toBe(true)
})

it('reports missing or malformed credentials with fixed diagnostics only', async () => {
  const warn = vi.fn()
  const missing = createSlackSocketTransport(transportOptions({
    resolveToken: async () => undefined,
    logger: { warn },
  }))
  await missing.start()
  expect(warn).toHaveBeenCalledWith('bot-routine-slack: Slack app token is unavailable; retrying')
  await missing.dispose()

  warn.mockClear()
  const malformed = createSlackSocketTransport(transportOptions({
    resolveToken: async () => 'not-a-token-with-private-content',
    logger: { warn },
  }))
  await malformed.start()
  expect(warn).toHaveBeenCalledWith('bot-routine-slack: Slack app token is malformed; retrying')
  expect(warn.mock.calls.flat().join(' ')).not.toContain('private-content')
  await malformed.dispose()
})

it('mounts a Bot source, resolves its credential, and disposes both owners', async () => {
  const accepted = vi.fn(async (_payload: unknown, _receivedAt: number) => {})
  const source = { accept: accepted, dispose: vi.fn() }
  const register = vi.fn(() => source)
  const resolve = vi.fn(async (reference: string) => ({ value: reference === 'SLACK_APP_TOKEN' ? 'xapp-mounted-token' : '' }))
  const ctx = mountContext(register, resolve)
  const captured: SlackSocketTransportOptions[] = []
  const started = vi.fn(async () => { await captured[0]?.resolveToken() })
  const disposed = vi.fn(async () => {})
  const factory = vi.fn((options: SlackSocketTransportOptions) => {
    captured.push(options)
    return { start: started, dispose: disposed }
  })
  const unmount = mountSlackRoutineSource(ctx, mountConfig(), factory)
  await vi.waitFor(() => { expect(started).toHaveBeenCalledOnce() })
  expect(register).toHaveBeenCalledWith({ source: 'team-slack', workspaceId: 'T123', appId: 'A123' })
  expect(resolve).toHaveBeenCalledWith('SLACK_APP_TOKEN')
  const options = captured[0]
  if (options === undefined) throw new Error('Transport options were not captured')
  expect(options.maxConcurrent).toBe(4)
  const payload = { event_id: 'EvMOUNTDEMO' }
  await options.accept(payload, 1_000)
  expect(accepted).toHaveBeenCalledWith(payload, 1_000)
  await unmount()
  expect(disposed).toHaveBeenCalledOnce()
  expect(source.dispose).toHaveBeenCalledOnce()
})

it('applies the production mount effect and stops a default transport on fiber disposal', async () => {
  const source = { accept: async (_payload: unknown, _receivedAt: number) => {}, dispose: vi.fn() }
  const ctx = mountContext(vi.fn(() => source), async () => undefined)
  apply(ctx, mountConfig())
  await ctx.fiber.dispose()
  expect(source.dispose).toHaveBeenCalledOnce()
})

it('keeps the Slack configuration defaults explicit and rejects invalid ids', () => {
  const config = new Config({ source: 'team-slack', workspaceId: 'T123', appId: 'A123' })
  expect(config.appTokenEnv).toBe('SLACK_APP_TOKEN')
  expect(config).toMatchObject({ maxConcurrent: 4, maxQueued: 32, maxPayloadBytes: 262_144,
    requestTimeoutMs: 10_000, socketOpenTimeoutMs: 15_000, reconnectBaseMs: 1_000,
    reconnectMaxMs: 30_000, disposeDrainTimeoutMs: 10_000 })
  expect(() => new Config({ source: 'team slack', workspaceId: 'T123', appId: 'A123' })).toThrow()
  expect(() => new Config({ source: 'team-slack', workspaceId: 'X123', appId: 'A123' })).toThrow()
  expect(() => new Config({ source: 'team-slack', workspaceId: 'T123', appId: 'B123' })).toThrow()
})
