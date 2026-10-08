/** Client-face process fixture used by Host-side protocol integration tests. */

import { parentPort, workerData } from 'node:worker_threads'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebSocket from 'ws'
import { ClientInspectorSource } from '../../src/client/bridge/transport.ts'
import { ClientRuntimeExecutor } from '../../src/client/cdp/runtime.ts'
import { ClientSourceCatalog } from '../../src/client/cdp/sources.ts'
import { publishCordisTree } from '../../src/client/inspection/cordis.ts'
import { inspectorId, type ClientRuntimeRequestId } from '../../src/shared/bridge/ids.ts'
import type { ClientRuntimeRequestFrame, ClientRuntimeResponseFrame } from '../../src/shared/bridge/messages/runtime/index.ts'
import type { InspectorClientBootstrap } from '../../src/shared/bridge/messages/control.ts'
import type { InspectorJsonValue } from '../../src/shared/json.ts'
import { createInspectorService } from '../../src/shared/service.ts'

interface ClientFixtureInput {
  readonly bootstrap: InspectorClientBootstrap
  readonly label: string
  readonly observeRuntime?: boolean
  readonly sourceCatalog?: {
    readonly sourceText: string
    readonly sourceMap: string
    readonly sourceUrl: string
    readonly sourceMapUrl: string
  }
}

interface ClientFixtureRequest {
  readonly id: number
  readonly op:
    | 'add-fiber'
    | 'close'
    | 'disconnect'
    | 'get-tree'
    | 'log-cordis'
    | 'log-value'
    | 'publish'
    | 'refresh-tree'
    | 'remove-fiber'
    | 'set-global'
    | 'set-ingest-paused'
    | 'wait-runtime-admission'
    | 'wait-runtime-settlement'
  readonly paused?: boolean
  readonly name?: string
  readonly value?: InspectorJsonValue
  readonly marker?: string
  readonly topic?: string
  readonly expression?: string
  readonly requestId?: string
  readonly timeoutMs?: number
}

const port = parentPort
if (port === null) throw new Error('Inspector Client fixture requires a Worker parent port')
const input = workerData as ClientFixtureInput
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
console.log = () => {}

const context = new Context()
const childFiber = context.plugin({ name: 'client-child', apply() {} })
await childFiber.await()
Reflect.set(globalThis, '__cordisClientProbe', context)
Reflect.set(globalThis, '__cordisClientFiberProbe', childFiber)

const sourceCatalog = input.sourceCatalog === undefined
  ? undefined
  : new ClientSourceCatalog([{
    scriptKey: inspectorId<'RuntimeScriptKey'>('bundle', 'scriptKey'),
    url: input.sourceCatalog.sourceUrl,
    hash: 'test',
    sourceMapUrl: input.sourceCatalog.sourceMapUrl,
    isModule: false,
    loadSource: async () => input.sourceCatalog!.sourceText,
    loadSourceMap: async () => input.sourceCatalog!.sourceMap,
  }])
const source = new ClientInspectorSource(input.bootstrap, input.label, sourceCatalog)
const runtimeProbe = input.observeRuntime ? observeRuntime(source) : undefined
const disposeCordis = publishCordisTree(context, source, {
  maxNodes: input.bootstrap.maxCordisNodes,
  maxBytes: input.bootstrap.maxFrameBytes - 4_096,
})
const service = createInspectorService(source)
let addedFiber: Fiber | undefined

port.on('message', (message: ClientFixtureRequest) => {
  void dispatch(message).then(
    (value) => {
      port.postMessage({ type: 'response', id: message.id, ok: true, value })
      if (message.op === 'close') port.close()
    },
    (error: unknown) => {
      port.postMessage({
        type: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  )
})
port.postMessage({ type: 'ready', fiberUid: childFiber.uid })

async function dispatch(message: ClientFixtureRequest): Promise<unknown> {
  switch (message.op) {
    case 'publish':
      source.publish(requiredString(message.topic, 'topic'), message.value ?? null)
      return undefined
    case 'set-global':
      Reflect.set(globalThis, requiredString(message.name, 'name'), message.value)
      return undefined
    case 'log-value':
      console.log(message.value, requiredString(message.marker, 'marker'))
      return undefined
    case 'log-cordis':
      console.log(context, childFiber, requiredString(message.marker, 'marker'))
      return undefined
    case 'get-tree':
      return await service.cordis.getTree()
    case 'set-ingest-paused': {
      const socket = Reflect.get(source, 'socket') as WebSocket | undefined
      if (socket === undefined) throw new Error('Inspector Client ingest socket is unavailable')
      if (message.paused) socket.pause()
      else socket.resume()
      return undefined
    }
    case 'wait-runtime-admission':
      if (runtimeProbe === undefined) throw new Error('Inspector Client runtime observation is disabled')
      return await runtimeProbe.waitForAdmission(
        requiredString(message.expression, 'expression'), requiredTimeout(message.timeoutMs),
      )
    case 'wait-runtime-settlement':
      if (runtimeProbe === undefined) throw new Error('Inspector Client runtime observation is disabled')
      return await runtimeProbe.waitForSettlement(
        inspectorId<'ClientRuntimeRequestId'>(requiredString(message.requestId, 'requestId'), 'requestId'),
        requiredTimeout(message.timeoutMs),
      )
    case 'disconnect': {
      const socket = Reflect.get(source, 'socket') as WebSocket | undefined
      socket?.terminate()
      return undefined
    }
    case 'refresh-tree':
      context.emit('internal/status', childFiber.ctx.fiber, childFiber.ctx.fiber.state)
      return undefined
    case 'add-fiber':
      addedFiber = context.plugin({ name: 'dynamic-client-child', apply() {} }).ctx.fiber
      await addedFiber.await()
      return addedFiber.uid
    case 'remove-fiber':
      await addedFiber?.dispose()
      addedFiber = undefined
      return undefined
    case 'close':
      runtimeProbe?.close()
      await addedFiber?.dispose()
      disposeCordis()
      source.close()
      await context.fiber.dispose()
      return undefined
  }
}

function requiredString(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`Inspector Client fixture ${field} is required`)
  return value
}

interface RuntimeSettlement {
  readonly abortedAtAdmission: boolean
  readonly aborted: boolean
  readonly pendingRequests: number
  readonly response?: ClientRuntimeResponseFrame
  readonly error?: string
}

function observeRuntime(subject: ClientInspectorSource) {
  // This fixture owns the source whose executor and request map are being observed.
  const executor = Reflect.get(subject, 'runtime')
  const requests = Reflect.get(subject, 'runtimeRequests')
  if (!(executor instanceof ClientRuntimeExecutor) || !(requests instanceof Map)) {
    throw new Error('Inspector Client runtime observation fields are unavailable')
  }
  const lifetime = new AbortController()
  const admissions = new Map<string, PromiseWithResolvers<ClientRuntimeRequestFrame>>()
  const settlements = new Map<ClientRuntimeRequestId, PromiseWithResolvers<RuntimeSettlement>>()
  const execute = executor.execute

  function admissionFor(expression: string) {
    let ticket = admissions.get(expression)
    if (ticket === undefined) {
      ticket = Promise.withResolvers<ClientRuntimeRequestFrame>()
      admissions.set(expression, ticket)
    }
    return ticket
  }

  executor.execute = (frame, signal, deferObjectCommit) => {
    const execution = execute.call(executor, frame, signal, deferObjectCommit)
    const abortedAtAdmission = signal?.aborted === true
    const settled = Promise.withResolvers<RuntimeSettlement>()
    settlements.set(frame.requestId, settled)
    if (frame.command.op === 'evaluate') admissionFor(frame.command.expression).resolve(frame)
    void execution.then(
      (response) => {
        if (lifetime.signal.aborted) return
        settled.resolve({ abortedAtAdmission, aborted: signal?.aborted === true, pendingRequests: requests.size, response })
      },
      (error: unknown) => {
        if (lifetime.signal.aborted) return
        settled.resolve({
          abortedAtAdmission,
          aborted: signal?.aborted === true,
          pendingRequests: requests.size,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return execution
  }

  return {
    async waitForAdmission(expression: string, timeoutMs: number): Promise<ClientRuntimeRequestFrame> {
      return await waitForProbe(
        admissionFor(expression).promise, lifetime.signal, timeoutMs,
        `Inspector Client Runtime evaluation ${JSON.stringify(expression)} was not admitted`,
      )
    },
    async waitForSettlement(requestId: ClientRuntimeRequestId, timeoutMs: number): Promise<RuntimeSettlement> {
      const settled = settlements.get(requestId)
      if (settled === undefined) throw new Error(`Inspector Client Runtime request ${requestId} was not admitted`)
      return await waitForProbe(
        settled.promise, lifetime.signal, timeoutMs,
        `Inspector Client Runtime request ${requestId} did not settle after cancellation`,
      )
    },
    close() {
      lifetime.abort()
      executor.execute = execute
      admissions.clear()
      settlements.clear()
    },
  }
}

async function waitForProbe<T>(
  observation: Promise<T>, signal: AbortSignal, timeoutMs: number, failure: string,
): Promise<T> {
  if (signal.aborted) throw new Error('Inspector Client runtime probe closed')
  const limit = Promise.withResolvers<never>()
  const onAbort = () => { limit.reject(new Error('Inspector Client runtime probe closed')) }
  const timer = setTimeout(() => { limit.reject(new Error(`${failure} within ${String(timeoutMs)}ms`)) }, timeoutMs)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([observation, limit.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function requiredTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Inspector Client fixture timeoutMs must be a positive integer')
  }
  return value
}
