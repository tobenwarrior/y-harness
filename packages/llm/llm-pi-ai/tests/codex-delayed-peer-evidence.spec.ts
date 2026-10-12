/** Exercise actual peer callbacks and stream ownership, without any native process or model. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { CodexBackendRuntime } from '../src/codex-backend.ts'
import type { CodexPeer } from '../src/codex-backend.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'

type NativeRequest = Parameters<ConstructorParameters<typeof CodexBackendRuntime>[0]['connect']>[0]

async function fixture(observe = vi.fn<NonNullable<ConstructorParameters<typeof CodexBackendRuntime>[0]['observeNativeItem']>>()) {
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  let handler: NativeRequest | undefined
  const permission = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ decision: 'decline' }))
  const request = vi.fn<CodexPeer['request']>(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'model/list') return { data: [{ model: 'fixture-model', supportedReasoningEfforts: [] }] }
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } }
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
    if (method === 'turn/interrupt') throw new Error('Owned synthetic interrupt rejection')
    throw new Error(`Unexpected native method: ${method}`)
  })
  const peer: CodexPeer = { request, notify() {}, subscribe: (callback) => {
    listeners.add(callback); return () => { listeners.delete(callback) }
  }, close: () => { listeners.clear() } }
  const runtime = new CodexBackendRuntime({ connect: async (callback) => { handler = callback; return peer },
    resolveAccess: () => ({ cwd: process.cwd(), sandbox: 'read-only', writableRoots: [], approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true }, request: permission }),
    connectionId: 'fixture-connection', resolveObservationProjectRoot: () => process.cwd(), observeNativeItem: observe,
    preferences: { enabled: true, models: [], tiers: {} }, persist: async () => {} })
  const runs: Array<{ controller: AbortController; done: Promise<StreamChunk[]> }> = []
  onTestFinished(async () => {
    try {
      for (const run of runs) run.controller.abort(new Error('Owned fixture stream cleanup'))
      await Promise.allSettled(runs.map(run => run.done))
      expect(runtime.view().running).toBe(0)
    } finally {
      runtime.close()
      expect(listeners.size).toBe(0)
    }
  })
  await runtime.refresh()
  const emit = (method: string, params: Record<string, unknown>) => { for (const callback of listeners) callback(method, params) }
  const complete = () => {
    emit('turn/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn',
      turn: { id: 'fixture-turn', status: 'completed' } })
  }
  const run = (signal?: AbortSignal): Promise<StreamChunk[]> => {
    const controller = new AbortController()
    const options: GenerateOptions = { provider: 'codex-backend', model: 'fixture-model', messages: [],
      signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]) }
    const done = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of runtime.stream(options)) chunks.push(chunk)
      return chunks
    })()
    runs.push({ controller, done })
    // A body assertion may fail before the test attaches its expected rejection.
    void done.catch(() => {})
    return done
  }
  const started = async () => {
    await vi.waitFor(() => { expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1) })
    await Promise.resolve()
  }
  const callback = async (method: string, params: Record<string, unknown>) => {
    if (handler === undefined) throw new Error('Fixture native request handler was not installed')
    return handler(method, params)
  }
  return { runtime, request, observe, permission, listeners, emit, complete, run, started, callback }
}

describe('Codex delayed peer evidence and interruption settlement', () => {
  it('waits for a delayed terminal notification without losing its stream owner', async () => {
    const f = await fixture(); const pending = f.run(); await f.started()
    expect(f.runtime.view().running).toBe(1)
    f.complete()
    expect((await pending).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(f.runtime.view().running).toBe(0)
    expect(f.listeners.size).toBe(1)
  })

  it('consumes rejected interruption and retries cleanup after an admitted turn aborts', async () => {
    const f = await fixture(); const controller = new AbortController()
    const pending = f.run(controller.signal)
    const settled = expect(pending).rejects.toThrow('Owned turn aborted')
    await f.started(); controller.abort(new Error('Owned turn aborted')); await settled
    expect(f.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toEqual([
      ['turn/interrupt', { threadId: 'fixture-thread', turnId: 'fixture-turn' }],
      ['turn/interrupt', { threadId: 'fixture-thread', turnId: 'fixture-turn' }],
    ])
    expect(f.runtime.view().running).toBe(0)
    expect(f.listeners.size).toBe(1)
  })

  it('keeps missing, foreign-turn and unobserved file changes out of permission request evidence', async () => {
    const f = await fixture(); const pending = f.run(); await f.started()
    f.emit('item/started', { threadId: 'fixture-thread', turnId: 'foreign-turn',
      item: { id: 'foreign', type: 'fileChange' } })
    f.emit('item/started', { threadId: 'fixture-thread', item: { id: 'unowned', type: 'fileChange' } })
    for (const itemId of ['absent', 'foreign', 'unowned']) {
      const params = { threadId: 'fixture-thread', turnId: 'fixture-turn', itemId }
      expect(await f.callback('item/fileChange/requestApproval', params)).toEqual({ decision: 'decline' })
      expect(f.permission.mock.calls.at(-1)).toEqual(['item/fileChange/requestApproval', params])
      expect(f.permission.mock.calls.at(-1)?.[1]).not.toHaveProperty('item')
    }
    f.complete(); await pending
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.permission).toHaveBeenCalledTimes(3)
  })

  it('surfaces invalidated settlement to a rejecting observer without granting settled learning facts', async () => {
    const facts: SkillLearningNativeItem[] = []
    const f = await fixture(vi.fn((_request, item) => {
      facts.push(item)
      if (item.phase === 'invalidated') throw new Error('Owned evidence sink failure')
    }))
    const pending = f.run(); await f.started()
    const identity = { threadId: 'fixture-thread', turnId: 'fixture-turn' }
    f.emit('item/started', { ...identity, item: { id: 'changed-kind', type: 'webSearch', status: 'inProgress' } })
    f.emit('item/completed', { ...identity, item: { id: 'changed-kind', type: 'fileChange', status: 'completed' } })
    f.complete()
    expect((await pending).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(facts.map(item => item.phase)).toEqual(['started', 'invalidated'])
    expect(facts.some(item => item.phase === 'settled')).toBe(false)
    expect(f.permission).not.toHaveBeenCalled()
    expect(f.runtime.view().running).toBe(0)
  })
})
