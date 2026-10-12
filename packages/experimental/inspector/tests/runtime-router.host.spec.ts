/** Worker deadline and response correlation under a controlled clock. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectorId } from '../src/shared/bridge/ids.ts'
import {
  INSPECTOR_PROTOCOL_VERSION,
  type InspectorSourceDescriptor,
  type WorkerToSourceFrame,
} from '../src/shared/bridge/messages/observation.ts'
import type {
  ClientRuntimeRequestFrame,
  ClientRuntimeResponseFrame,
} from '../src/shared/bridge/messages/runtime/index.ts'
import { InspectorSourceRegistry, type SourceConnection } from '../src/worker/bridge/hub.ts'
import { ClientRuntimeRouter } from '../src/worker/bridge/runtime-rpc.ts'

describe('Client Runtime Worker deadline', () => {
  afterEach(() => { vi.useRealTimers() })

  it('cancels an expired request and accepts recovery after a late response', async () => {
    const sent: WorkerToSourceFrame[] = []
    const close = vi.fn()
    const connection: SourceConnection = {
      kind: 'client',
      send(frame) { sent.push(frame) },
      close,
    }
    const source: InspectorSourceDescriptor = {
      sourceId: inspectorId<'InspectorSourceId'>('deadline-client', 'sourceId'),
      generation: inspectorId<'InspectorSourceGeneration'>('deadline-generation', 'generation'),
      kind: 'client',
      label: 'Deadline Client',
      timeOriginMs: 0,
      capabilities: [{ type: 'client-runtime', origin: 'http://client.test' }],
    }
    const sessionId = inspectorId<'ClientRuntimeSessionId'>('deadline-session', 'sessionId')
    const sources = new InspectorSourceRegistry([], 16_384, 4)
    const router = new ClientRuntimeRouter(sources, 20)
    vi.useFakeTimers()
    try {
      sources.receive(connection, {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'source/open',
        source,
        topics: [],
      })
      expect(sent).toEqual([{
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'source/accepted',
        sourceId: source.sourceId,
        generation: source.generation,
      }])
      const target = router.targets()[0]
      if (target === undefined) throw new Error('Client Runtime source was not admitted')
      sent.length = 0

      const timedOut = router.request(target, sessionId, {
        op: 'evaluate', expression: 'new Promise(() => {})', awaitPromise: true,
      })
      const timeoutError = timedOut.then(() => undefined, (error: unknown) => error)
      const firstRequest = runtimeRequest(sent.at(-1))
      await vi.advanceTimersByTimeAsync(19)
      expect(sent).toEqual([firstRequest])
      await vi.advanceTimersByTimeAsync(1)
      const error = await timeoutError
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ message: 'Client Runtime evaluate timed out after 20ms' })
      const cancellation = {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-runtime/cancel',
        sourceId: source.sourceId,
        generation: source.generation,
        sessionId,
        requestId: firstRequest.requestId,
      }
      expect(sent).toEqual([firstRequest, cancellation])
      expect(router.bySource(source)).toBe(target)
      expect(vi.getTimerCount()).toBe(0)

      const recovery = router.request(target, sessionId, {
        op: 'evaluate', expression: '42', returnByValue: true,
      })
      const recoverySettled = vi.fn()
      void recovery.then(recoverySettled, recoverySettled)
      const secondRequest = runtimeRequest(sent.at(-1))
      expect(secondRequest.requestId).not.toBe(firstRequest.requestId)
      expect(secondRequest.sessionId).toBe(firstRequest.sessionId)
      expect(secondRequest.sourceId).toBe(firstRequest.sourceId)
      expect(secondRequest.generation).toBe(firstRequest.generation)

      sources.receive(connection, numberResponse(firstRequest, 999))
      await Promise.resolve()
      expect(recoverySettled).not.toHaveBeenCalled()
      expect(sent.at(-1)).toEqual(cancellation)
      expect(sent.filter(frame => frame.t === 'client-runtime/response-acknowledged')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(1)

      sources.receive(connection, numberResponse(secondRequest, 42))
      await expect(recovery).resolves.toEqual({
        op: 'evaluate',
        completion: { result: { descriptor: { type: 'number', value: 42 } } },
      })
      expect(recoverySettled).toHaveBeenCalledOnce()
      expect(sent.at(-1)).toEqual({
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-runtime/response-acknowledged',
        sourceId: source.sourceId,
        generation: source.generation,
        sessionId,
        requestId: secondRequest.requestId,
      })
      expect(router.bySource(source)).toBe(target)
      expect(vi.getTimerCount()).toBe(0)
      expect(close).not.toHaveBeenCalled()
    } finally {
      router.close()
      sources.close()
      vi.useRealTimers()
    }
  })
})

function runtimeRequest(frame: WorkerToSourceFrame | undefined): ClientRuntimeRequestFrame {
  if (frame?.t !== 'client-runtime/request') throw new Error('Client Runtime request was not dispatched')
  return frame
}

function numberResponse(frame: ClientRuntimeRequestFrame, value: number): ClientRuntimeResponseFrame {
  return {
    v: INSPECTOR_PROTOCOL_VERSION,
    t: 'client-runtime/response',
    sourceId: frame.sourceId,
    generation: frame.generation,
    sessionId: frame.sessionId,
    requestId: frame.requestId,
    outcome: {
      ok: true,
      result: {
        op: 'evaluate',
        completion: { result: { descriptor: { type: 'number', value } } },
      },
    },
  }
}
