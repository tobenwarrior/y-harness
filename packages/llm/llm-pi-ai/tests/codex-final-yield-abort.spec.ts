/** Cancellation while a consumer holds a yielded block cannot wait for another native event. */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CodexBackendRuntime, declineCodexRequest } from '../src/codex-backend.ts'
import type { CodexPeer } from '../src/codex-backend.ts'

it.each(['block-start', 'text-delta', 'block-end'] as const)(
  'releases a turn aborted while suspended at %s without another native event', async (yieldType) => {
    const callbacks = new Set<(method: string, params: Record<string, unknown>) => void>()
    const events: string[] = []
    const emit = (method: string, params: Record<string, unknown>) => {
      events.push(method)
      for (const callback of callbacks) callback(method, params)
    }
    const started = Promise.withResolvers<undefined>()
    const request = vi.fn<CodexPeer['request']>(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'owned-thread' } }
      if (method === 'turn/start') { started.resolve(undefined); return { turn: { id: 'owned-turn' } } }
      return {}
    })
    const close = vi.fn(() => { emit('__closed', {}); callbacks.clear() })
    const peer: CodexPeer = { request, close, notify() {},
      subscribe: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback) } } }
    const persist = vi.fn(async () => {})
    const runtime = new CodexBackendRuntime({ preferences: { enabled: true, tiers: {}, models: [{
      id: 'owned-model', name: 'Owned', description: '', efforts: [], serviceTiers: [], inputModalities: ['text'],
    }] }, connect: async () => peer, persist,
    resolveAccess: () => ({ cwd: process.cwd(), sandbox: 'read-only', writableRoots: [],
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, request: declineCodexRequest }),
    })
    const pending: { draining?: Promise<void> } = {}
    onTestFinished(async () => { runtime.close(); await pending.draining?.catch(() => {}) })
    const controller = new AbortController()
    const stream = runtime.stream({ provider: 'codex-backend', model: 'owned-model', messages: [], signal: controller.signal })
    const first = stream.next()
    await started.promise
    emit('item/agentMessage/delta', { threadId: 'owned-thread', turnId: 'owned-turn', itemId: 'owned-item', delta: 'Owned delta' })
    expect((await first).value).toMatchObject({ type: 'block-start' })
    if (yieldType !== 'block-start') expect((await stream.next()).value).toMatchObject({ type: 'text-delta' })
    if (yieldType === 'block-end') {
      const ended = stream.next()
      emit('item/completed', { threadId: 'owned-thread', turnId: 'owned-turn', item: { id: 'owned-item', type: 'agentMessage' } })
      expect((await ended).value).toMatchObject({ type: 'block-end' })
    }
    expect(runtime.view().running).toBe(1)
    const heldSubscriptions = callbacks.size
    await expect(runtime.configure(false)).rejects.toThrow('Finish the active Codex turn')
    await expect(runtime.logout()).rejects.toThrow('Finish the active Codex turn')
    const eventCount = events.length
    const reason = new Error('Owned cancellation at a suspended yield')
    controller.abort(reason)
    const remaining: StreamChunk[] = []
    const draining = (async () => { for await (const chunk of stream) remaining.push(chunk) })()
    pending.draining = draining
    let timeout: ReturnType<typeof setTimeout> | undefined
    const stalled = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { reject(new Error('Cancelled stream still awaits a native event')) }, 250)
    })
    try { await expect(Promise.race([draining, stalled])).rejects.toBe(reason) }
    finally { clearTimeout(timeout) }
    expect(events).toHaveLength(eventCount)
    expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'owned-thread', turnId: 'owned-turn' })
    expect(callbacks.size).toBe(heldSubscriptions - 1)
    expect(runtime.view().running).toBe(0)
    await runtime.configure(false)
    expect(persist).toHaveBeenCalledOnce()
    runtime.close()
    expect(close).toHaveBeenCalledOnce()
    expect(callbacks.size).toBe(0)
  },
)
