/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@yharness/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@yharness/host-webserver'
import type { PeerScope } from '@yharness/typert-protocol'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { bindSharedAccessSocket } from './shared-access.ts'
import { API_PATH } from './api-path.ts'
import {
  SHARED_BOTS_ENDPOINT_PREFIX,
  SHARED_BOTS_PATH,
  SHARED_MAX_BODY_READ_MS,
  SHARED_MAX_CONCURRENT_BODY_READS,
  SHARED_MAX_CONCURRENT_REQUESTS,
  SHARED_MAX_REQUEST_BODY_BYTES,
} from './rpc.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { OperatorPeer } from './operator-peer.ts'
import type {
  PeerAdmission,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
  HostSharedConnectionRpc,
  SharedAccessAuthenticator,
  SharedConnectionEnrollmentHandler,
  SharedConnectionLimits,
  SharedConnectionRpcOptions,
  SharedConnectionSocket,
  SharedConnectionUpgradeOptions,
  SharedConnectionUpgradeHandler,
  SharedPeerAdmission,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

interface RpcResponseProjection {
  readonly result: ConnectionRpcHandlerResult
  readonly headers?: Readonly<Record<string, string>>
}

declare module '@yharness/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The operator Peer every admitted request speaks for. */
  readonly operator: PeerScope
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   * @param maxRequestBodyBytes - maximum buffered body size for registered RPC routes.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
    private readonly maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
  ) {
    super(ctx, 'connection')
    this.operator = new OperatorPeer(ctx)
    ctx.effect(() => () => this.operator.dispose(), 'client-connection: operator Peer')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Isolated collaborator Bot channel registry; no ordinary Remote is mounted here. */
  get sharedRpc(): HostSharedConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, authenticator, handler, options) =>
        this.registerShared(owner, channel, authenticator, handler, options),
      enroll: (channel, handler, options) => this.registerSharedEnrollment(owner, channel, handler, options),
      upgrade: (channel, authenticator, handler, options) =>
        this.registerSharedUpgrade(owner, channel, authenticator, handler, options),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Apply the configured Host/Origin fence, then browser authentication. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }

  /** A request that passes the fence and authentication speaks for the operator. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    const rejection = this.requestRejection(request)
    return rejection === undefined ? { peer: this.operator } : { rejection }
  }

  /** Apply only the Host/Origin fence and collaborator authentication. */
  async admitShared(request: ConnectionTrustRequest, authenticator: SharedAccessAuthenticator): Promise<SharedPeerAdmission> {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return { rejection: 403 }
    return authenticator.admit(request)
  }

  /** Authenticate an index request through the process-token exchange or cookie. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    return this.browserAuth.authorizeIndex(request, response)
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private registerWebRoute(
    owner: Context,
    register: (webServer: WebServer) => () => void | Promise<void>,
    label: string,
  ): () => Promise<void> {
    const webServer = owner.get('webServer')
    if (webServer !== undefined) {
      return owner.effect(() => register(webServer), label)
    }
    const fiber = owner.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => register(webCtx.webServer), label)
    })
    return () => fiber.dispose()
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, (endpoint, payload, signal) =>
      handler(endpoint, payload, signal, this.operator))
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler)
      },
    }
    return this.registerWebRoute(
      owner,
      webServer => webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerShared(
    owner: Context,
    channel: string,
    authenticator: SharedAccessAuthenticator,
    handler: ConnectionRpcHandler,
    options: SharedConnectionRpcOptions,
  ): () => Promise<void> {
    if (channel !== SHARED_BOTS_PATH) {
      throw new Error(`connection: invalid shared collaborator channel ${JSON.stringify(channel)}`)
    }
    const endpoints = validateSharedEndpoints(options.endpoints)
    const limits = resolveSharedLimits(options, this.maxRequestBodyBytes)
    const concurrency = createSharedConcurrency(limits.maxConcurrentRequests)
    const bodyConcurrency = createSharedConcurrency(limits.maxConcurrentBodyReads)
    // Authentication is deliberately isolated from the handler capacity. An
    // unauthenticated client must not occupy all eight shared request slots
    // while its durable cookie lookup is waiting on storage.
    const authenticationConcurrency = createSharedConcurrency(2)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        if (!authenticationConcurrency.tryAcquire()) {
          rejectSharedHttp(res)
          return
        }
        let admission: SharedPeerAdmission
        try {
          admission = await this.admitShared(req, authenticator)
        } finally {
          authenticationConcurrency.release()
        }
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const carrier = rpcFetchHandler(channel, (endpoint, payload, signal) =>
          sharedHandler(handler, endpoints)(endpoint, payload, signal, admission.peer))
        await bridgeSharedRequest(req, res, carrier, limits, bodyConcurrency, concurrency)
      },
    }
    return this.registerWebRoute(
      owner,
      webServer => webServer.register(route),
      `client-connection: ${channel} shared collaborator rpc channel`,
    )
  }

  private registerSharedEnrollment(
    owner: Context,
    channel: typeof SHARED_BOTS_PATH,
    handler: SharedConnectionEnrollmentHandler,
    options: SharedConnectionLimits | undefined,
  ): () => Promise<void> {
    const path = `${channel}/bots/share/enroll`
    const limits = resolveSharedLimits(options, this.maxRequestBodyBytes)
    const concurrency = createSharedConcurrency(limits.maxConcurrentRequests)
    const bodyConcurrency = createSharedConcurrency(limits.maxConcurrentBodyReads)
    const route: WebRoute = {
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, this.trustedHosts)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const carrier = rpcFetchHandler(
          channel,
          (endpoint, payload, signal, request) => handler(endpoint, payload, signal, request),
          projectEnrollmentResult,
        )
        await bridgeSharedRequest(req, res, carrier, limits, bodyConcurrency, concurrency)
      },
    }
    return this.registerWebRoute(
      owner,
      webServer => webServer.register(route),
      `client-connection: ${path} shared collaborator enrollment`,
    )
  }

  private registerSharedUpgrade(
    owner: Context,
    channel: typeof SHARED_BOTS_PATH,
    authenticator: SharedAccessAuthenticator,
    handler: SharedConnectionUpgradeHandler,
    options: SharedConnectionUpgradeOptions,
  ): () => Promise<void> {
    assertSharedUpgradeOptions(options)
    const route: WebUpgradeRoute = {
      path: channel,
      handler: async (req, socket, head) => {
        const admission = await this.admitShared(req, authenticator)
        if ('rejection' in admission) {
          rejectSharedUpgrade(socket, admission.rejection)
          return
        }
        bindSharedAccessSocket(admission.peer, socket)
        if (!bindSharedSocketLimit(socket, head, options.maxInboundBytes)) return
        try {
          await handler(req, socket, head, admission.peer)
        } catch {
          if (!socket.destroyed) socket.destroy()
        }
      },
    }
    return this.registerWebRoute(
      owner,
      webServer => webServer.registerUpgrade(route),
      `client-connection: ${channel} shared collaborator WebSocket`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, (endpoint, payload, signal) =>
        handler(endpoint, payload, signal, this.operator)),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function sharedHandler(handler: ConnectionRpcHandler, endpoints: ReadonlySet<string>): ConnectionRpcHandler {
  return async (endpoint, payload, signal, peer) => {
    if (!endpoints.has(endpoint)) {
      return {
        ok: false,
        error: {
          code: 'gateway/forbidden',
          message: 'shared collaborator endpoint is not part of the Bot namespace',
          details: {},
        },
      }
    }
    try {
      return await handler(endpoint, payload, signal, peer)
    } catch {
      return {
        ok: false,
        error: {
          code: 'gateway/internal',
          message: 'shared Bot handler failed',
          details: {},
        },
      }
    }
  }
}

function validateSharedEndpoints(values: readonly string[]): ReadonlySet<string> {
  const endpoints = new Set<string>()
  for (const endpoint of values) {
    if (!endpoint.startsWith(SHARED_BOTS_ENDPOINT_PREFIX)
      || endpoint.length === SHARED_BOTS_ENDPOINT_PREFIX.length
      || endpoint.split('/').some(segment => segment === '' || segment === '.' || segment === '..'
        || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
      throw new Error(`connection: invalid shared collaborator endpoint ${JSON.stringify(endpoint)}`)
    }
    if (endpoints.has(endpoint)) {
      throw new Error(`connection: duplicate shared collaborator endpoint ${JSON.stringify(endpoint)}`)
    }
    endpoints.add(endpoint)
  }
  return endpoints
}

function rejectSharedUpgrade(
  socket: SharedConnectionSocket,
  status: 401 | 403,
): void {
  if (socket.destroyed) return
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

function rpcFetchHandler(
  channel: string,
  dispatch: (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    request: ConnectionIndexRequest,
  ) => Promise<ConnectionRpcHandlerResult>,
  project: (result: ConnectionRpcHandlerResult) => RpcResponseProjection = result => ({ result }),
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      const requestFacts: ConnectionIndexRequest = {
        headers: request.headers,
        method: request.method,
        url: request.url,
      }
      try {
        const result = project(await dispatch(endpoint, message.payload, request.signal, requestFacts))
        return fullResponse(message.rpcId, result.result, result.headers)
      } catch {
        return errorResponse(message.rpcId, {
          code: 'gateway/internal',
          message: 'Connection handler failed',
          details: {},
        })
      }
    },
  }
}

function projectEnrollmentResult(result: ConnectionRpcHandlerResult): RpcResponseProjection {
  if (!result.ok || !isRecord(result.value) || typeof result.value.setCookie !== 'string') return { result }
  const { setCookie, ...value } = result.value
  return {
    result: { ok: true, value },
    headers: { 'set-cookie': setCookie },
  }
}

function assertSharedUpgradeOptions(options: SharedConnectionUpgradeOptions): void {
  if (!Number.isSafeInteger(options.maxInboundBytes) || options.maxInboundBytes <= 0) {
    throw new Error('connection: shared collaborator WebSocket maxInboundBytes must be a positive safe integer')
  }
}

function bindSharedSocketLimit(socket: SharedConnectionSocket, head: Uint8Array, maxBytes: number): boolean {
  let received = 0
  let remainingFrameBytes = 0
  let header: number[] = []

  const consume = (chunk: Uint8Array): boolean => {
    received += chunk.byteLength
    if (received > maxBytes) return false
    let offset = 0
    while (offset < chunk.byteLength) {
      if (remainingFrameBytes > 0) {
        const consumed = Math.min(remainingFrameBytes, chunk.byteLength - offset)
        remainingFrameBytes -= consumed
        offset += consumed
        continue
      }
      while (header.length < 2 && offset < chunk.byteLength) header.push(chunk[offset++] ?? 0)
      if (header.length < 2) return true
      const code = (header[1] ?? 0) & 0x7f
      const extensionBytes = code === 126 ? 2 : code === 127 ? 8 : 0
      const maskBytes = ((header[1] ?? 0) & 0x80) === 0 ? 0 : 4
      const headerBytes = 2 + extensionBytes + maskBytes
      while (header.length < headerBytes && offset < chunk.byteLength) header.push(chunk[offset++] ?? 0)
      if (header.length < headerBytes) return true
      let length = 0
      const lengthEnd = 2 + extensionBytes
      for (let index = 2; index < lengthEnd; index += 1) {
        length = length * 256 + (header[index] ?? 0)
        if (!Number.isSafeInteger(length) || length > maxBytes) return false
      }
      remainingFrameBytes = length
      header = []
    }
    return true
  }

  if (!consume(head)) {
    if (!socket.destroyed) socket.destroy()
    return false
  }
  socket.on('data', (chunk) => {
    if (!consume(chunk) && !socket.destroyed) socket.destroy()
  })
  return true
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(
  rpcId: RpcIdType,
  result: Awaited<ReturnType<ConnectionRpcHandler>>,
  headers: Readonly<Record<string, string>> = {},
): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body, { headers })
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body, { headers })
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts, { headers })
}

interface SharedConcurrency {
  readonly tryAcquire: () => boolean
  readonly release: () => void
}

type ResolvedSharedLimits = Required<Pick<SharedConnectionLimits, 'maxRequestBodyBytes' | 'maxConcurrentRequests' | 'maxConcurrentBodyReads' | 'maxBodyReadMs'>>

function createSharedConcurrency(maxConcurrentRequests: number): SharedConcurrency {
  let active = 0
  return {
    tryAcquire: () => {
      if (active >= maxConcurrentRequests) return false
      active += 1
      return true
    },
    release: () => {
      // Every successful acquisition has one matching finally block. Keep the
      // guard local so a malformed carrier cannot make the counter negative.
      if (active > 0) active -= 1
    },
  }
}

function sharedRequestCarrier(
  carrier: ConnectionFetchHandler,
  releaseBody: () => void,
  concurrency: SharedConcurrency,
): ConnectionFetchHandler {
  return {
    requestBodyMode: request => carrier.requestBodyMode(request),
    fetch: async (request) => {
      releaseBody()
      if (!concurrency.tryAcquire()) return sharedCapacityResponse()
      try {
        return await carrier.fetch(request)
      } finally {
        concurrency.release()
      }
    },
  }
}

async function bridgeSharedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  carrier: ConnectionFetchHandler,
  limits: ResolvedSharedLimits,
  bodyConcurrency: SharedConcurrency,
  concurrency: SharedConcurrency,
): Promise<void> {
  if (!bodyConcurrency.tryAcquire()) {
    rejectSharedHttp(res)
    return
  }
  let bodyAcquired = true
  const releaseBody = (): void => {
    if (!bodyAcquired) return
    bodyAcquired = false
    bodyConcurrency.release()
  }
  try {
    await bridge(
      req,
      res,
      sharedRequestCarrier(carrier, releaseBody, concurrency),
      limits.maxRequestBodyBytes,
      limits.maxBodyReadMs,
    )
  } finally {
    releaseBody()
  }
}

function resolveSharedLimits(
  options: SharedConnectionLimits | undefined,
  ordinaryMaxRequestBodyBytes: number,
): ResolvedSharedLimits {
  const requestedBodyBytes = options?.maxRequestBodyBytes ?? SHARED_MAX_REQUEST_BODY_BYTES
  if (!Number.isSafeInteger(requestedBodyBytes)
    || requestedBodyBytes <= 0
    || requestedBodyBytes > SHARED_MAX_REQUEST_BODY_BYTES) {
    throw new Error(`connection: shared collaborator request body cap must be an integer from 1 to ${String(SHARED_MAX_REQUEST_BODY_BYTES)} bytes`)
  }
  const requestedConcurrency = options?.maxConcurrentRequests ?? SHARED_MAX_CONCURRENT_REQUESTS
  if (!Number.isSafeInteger(requestedConcurrency)
    || requestedConcurrency <= 0
    || requestedConcurrency > SHARED_MAX_CONCURRENT_REQUESTS) {
    throw new Error(`connection: shared collaborator concurrency cap must be an integer from 1 to ${String(SHARED_MAX_CONCURRENT_REQUESTS)}`)
  }
  const requestedBodyReads = options?.maxConcurrentBodyReads ?? SHARED_MAX_CONCURRENT_BODY_READS
  if (!Number.isSafeInteger(requestedBodyReads)
    || requestedBodyReads <= 0
    || requestedBodyReads > SHARED_MAX_CONCURRENT_BODY_READS) {
    throw new Error(`connection: shared collaborator body-read concurrency cap must be an integer from 1 to ${String(SHARED_MAX_CONCURRENT_BODY_READS)}`)
  }
  const requestedBodyReadMs = options?.maxBodyReadMs ?? SHARED_MAX_BODY_READ_MS
  if (!Number.isSafeInteger(requestedBodyReadMs)
    || requestedBodyReadMs <= 0
    || requestedBodyReadMs > SHARED_MAX_BODY_READ_MS) {
    throw new Error(`connection: shared collaborator body-read timeout must be an integer from 1 to ${String(SHARED_MAX_BODY_READ_MS)} milliseconds`)
  }
  if (!Number.isSafeInteger(ordinaryMaxRequestBodyBytes) || ordinaryMaxRequestBodyBytes <= 0) {
    throw new Error('connection: ordinary request body cap must be a positive safe integer')
  }
  return {
    maxRequestBodyBytes: Math.min(requestedBodyBytes, ordinaryMaxRequestBodyBytes),
    maxConcurrentRequests: requestedConcurrency,
    maxConcurrentBodyReads: requestedBodyReads,
    maxBodyReadMs: requestedBodyReadMs,
  }
}

function sharedCapacityResponse(): Response {
  return new Response('shared collaborator capacity is busy', {
    status: 429,
    headers: { connection: 'close', 'retry-after': '1' },
  })
}

function rejectSharedHttp(
  response: {
    writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
    end(body?: string): unknown
  },
): void {
  response.writeHead(429, { connection: 'close', 'retry-after': '1' })
  response.end('shared collaborator capacity is busy')
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
