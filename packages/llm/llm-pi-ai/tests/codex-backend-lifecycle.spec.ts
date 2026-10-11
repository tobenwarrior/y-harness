import { describe, expect, it, onTestFinished } from 'vitest'
import { createAssistantMessage, createUserMessage, ServiceTierId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CodexBackendAdapter, CodexBackendRuntime, declineCodexRequest, parseCodexModels, projectCodexHistory } from '../src/codex-backend.ts'
import type { CodexPeer, CodexPreferences } from '../src/codex-backend.ts'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'

type Obj = Record<string, unknown>
const model = { id: 'fixture-model', name: 'Fixture', description: '', efforts: [], serviceTiers: [], inputModalities: ['text' as const] }
const request = (fields: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'codex-backend', model: model.id, messages: [], ...fields })
const collect = async (runtime: CodexBackendRuntime, options = request()): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = []
  for await (const chunk of runtime.stream(options)) chunks.push(chunk)
  return chunks
}
function fixture(
  preferences: CodexPreferences = { enabled: true, models: [model], tiers: {} },
  evidence?: { maximum: number; observe(item: SkillLearningNativeItem): void },
) {
  const listeners = new Set<(method: string, params: Obj) => void>()
  const calls: Array<{ method: string; params: object }> = []
  const persisted: CodexPreferences[] = []
  let closed = 0
  let handler: ((method: string, params: Obj) => Promise<unknown>) | undefined
  let reply: (method: string, params: object) => Promise<unknown> = async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'model/list') return { data: [{ model: model.id }] }
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } }
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'fixture-login', userCode: 'FIXTURE', verificationUrl: 'https://auth.openai.com/codex/device' }
    return {}
  }
  const emit = (method: string, params: Obj = {}) => { for (const callback of listeners) callback(method, params) }
  const peer: CodexPeer = {
    request: async (method, params) => { calls.push({ method, params }); return reply(method, params) },
    notify() {}, subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    close: () => { closed++; emit('__closed') },
  }
  const runtime = new CodexBackendRuntime({ preferences, connect: async (callback) => { handler = callback; return peer },
    persist: async (next) => { persisted.push(structuredClone(next)) },
    resolveAccess: () => ({ cwd: '/fixture/project', sandbox: 'read-only', writableRoots: [], approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }, request: declineCodexRequest }),
    ...(evidence === undefined ? {} : { connectionId: 'fixture-profile', nativeEvidenceMaxItems: evidence.maximum,
      observeNativeItem: (_options: GenerateOptions, item: SkillLearningNativeItem) => { evidence.observe(item) } }),
  })
  onTestFinished(() => { runtime.close() })
  const complete = (status = 'completed') => { emit('turn/completed', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status } }) }
  const finishOnStart = (events: () => void = () => { complete() }) => {
    const previous = reply
    reply = async (method, params) => {
      const result = await previous(method, params)
      if (method === 'turn/start') queueMicrotask(events)
      return result
    }
  }
  return { runtime, peer, calls, persisted, emit, complete, finishOnStart,
    get closed() { return closed },
    setReply(next: typeof reply) { reply = next },
    nativeRequest: (method: string, params: Obj) => { if (handler === undefined) throw new Error('Fixture peer not initialized'); return handler(method, params) },
  }
}

describe('Codex backend state and refusal paths', () => {
  it('keeps the disabled route and stale model selections unavailable', async () => {
    const f = fixture({ enabled: false, models: [model], tiers: {} })
    const adapter = new CodexBackendAdapter(f.runtime)
    expect(await adapter.listModels('codex-backend')).toEqual([])
    await expect(collect(f.runtime)).rejects.toThrow(/Enable/)
    await expect(adapter.resolveModel('codex-backend', 'missing')).rejects.toThrow(/catalog/)
    const g = fixture()
    await expect(collect(g.runtime, request({ model: 'missing' }))).rejects.toThrow(/catalog/)
    await expect(collect(g.runtime, request({ serviceTier: ServiceTierId('invented') }))).rejects.toThrow(/processing tier/)
    expect(g.calls).toEqual([])
  })

  it('refuses enabling a disconnected account and an unknown stored tier', async () => {
    const f = fixture()
    await expect(f.runtime.configure(true)).rejects.toThrow(/Sign in/)
    await expect(f.runtime.configure(false, 'missing', 'default')).rejects.toThrow(/processing tier/)
    await expect(f.runtime.configure(false, model.id, 'invented')).rejects.toThrow(/processing tier/)
    expect(f.persisted).toEqual([])
  })

  it('publishes model metadata only while enabled and keeps standard without a default effort', async () => {
    const f = fixture()
    const adapter = new CodexBackendAdapter(f.runtime)
    expect(adapter.providerInfo('codex-backend')).toEqual({ id: 'codex-backend', name: 'Codex (native backend)', auxiliaryGeneration: 'native' })
    expect(await adapter.listModels('codex-backend')).toEqual([{ provider: 'codex-backend', id: model.id, name: 'Fixture', description: '', inputModalities: ['text'] }])
    expect(await adapter.resolveModel('codex-backend', model.id)).toMatchObject({ reasoning: { efforts: [] }, serviceTiers: { defaultTier: 'default' } })
    expect((await adapter.resolveModel('codex-backend', model.id)).reasoning).not.toHaveProperty('defaultEffort')
  })

  it('uses protocol defaults for malformed optional catalog fields without inventing IDs', () => {
    expect(parseCodexModels({ data: [null, {}, { id: 'fallback', displayName: '', supportedReasoningEfforts: [null, {}, { reasoningEffort: 'low' }],
      serviceTiers: [null, {}, { id: 'priority', name: '' }], inputModalities: ['audio'], defaultReasoningEffort: 'unknown' }] })).toEqual([
      { id: 'fallback', name: 'fallback', description: '', efforts: [{ id: 'low', description: '' }], serviceTiers: [{ id: 'priority', name: 'priority', description: '' }], inputModalities: ['text', 'image'] },
    ])
    expect(parseCodexModels({ data: [{ model: 'plain' }] })).toEqual([{ id: 'plain', name: 'plain', description: '', efforts: [], serviceTiers: [], inputModalities: ['text', 'image'] }])
    expect(() => parseCodexModels(null)).toThrow(/invalid model catalog/)
  })

  it('deduplicates paginated models and stops at the supported complete-catalog bound', async () => {
    const f = fixture()
    f.setReply(async (method, params) => method === 'account/read' ? { account: { type: 'chatgpt' } }
      : method === 'model/list' ? { data: [{ model: 'same', displayName: 'Latest' }], ...('cursor' in params ? {} : { nextCursor: 'opaque-next' }) } : {})
    await f.runtime.refresh()
    expect(f.runtime.view().label).toBe('ChatGPT account')
    expect(f.runtime.models()).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'model/list').map(call => call.params)).toEqual([
      { limit: 100, includeHidden: false }, { limit: 100, includeHidden: false, cursor: 'opaque-next' },
    ])
    f.setReply(async method => method === 'model/list' ? { data: [], nextCursor: 'next' } : { account: null })
    await expect(f.runtime.refresh()).rejects.toThrow(/page limit/)
    expect(f.calls.filter(call => call.method === 'model/list')).toHaveLength(22)
  })

  it('invalidates a captured history reader when the connection closes during a read', async () => {
    const f = fixture()
    expect(f.runtime.codingSessionReader()).toBeUndefined()
    await f.runtime.refresh()
    const reader = f.runtime.codingSessionReader()!
    expect(reader.connected()).toBe(true)
    const response = Promise.withResolvers<unknown>()
    f.setReply(async () => response.promise)
    const pending = reader.request('thread/read', { threadId: 'fixture-original' })
    const rejected = expect(pending).rejects.toThrow(/connection changed/)
    f.emit('__closed')
    response.resolve({ thread: {} })
    await rejected
    expect(reader.connected()).toBe(false)
    await expect(reader.request('thread/list', {})).rejects.toThrow(/connection changed/)
  })

  it('closes an initialized peer if runtime disposal won the startup race', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<undefined>(); const initialized = Promise.withResolvers<unknown>()
    f.setReply(async () => { entered.resolve(undefined); return initialized.promise })
    const pending = f.runtime.refresh()
    const rejected = expect(pending).rejects.toThrow(/could not start/)
    await entered.promise
    f.runtime.close(); initialized.resolve({})
    await rejected
    expect(f.closed).toBeGreaterThan(0)
    await expect(f.runtime.refresh()).rejects.toThrow(/closed/)
  })

  it.each([
    { type: 'wrong', loginId: 'login', userCode: 'CODE', verificationUrl: 'https://auth.openai.com/codex/device' },
    { type: 'chatgptDeviceCode', loginId: '', userCode: 'CODE', verificationUrl: 'https://auth.openai.com/codex/device' },
    { type: 'chatgptDeviceCode', loginId: 'login', userCode: '', verificationUrl: 'https://auth.openai.com/codex/device' },
    { type: 'chatgptDeviceCode', loginId: 'login', userCode: 'CODE', verificationUrl: 'https://fixture.invalid/codex/device' },
  ])('rejects invalid device instructions without a busy state: %j', async (response) => {
    const f = fixture(); f.setReply(async () => response)
    await expect(f.runtime.login(true)).rejects.toThrow(/invalid sign-in/)
    expect(f.runtime.view().busy).toBe(false)
  })

  it('blocks concurrent sign-in and withdraws the profile after explicit logout', async () => {
    const f = fixture()
    await f.runtime.login(true)
    await expect(f.runtime.login(true)).rejects.toThrow(/active Codex operation/)
    await expect(collect(f.runtime)).rejects.toThrow(/active Codex operation/)
    await f.runtime.logout()
    expect(f.calls.map(call => call.method)).toContain('account/login/cancel')
    expect(f.calls.map(call => call.method)).toContain('account/logout')
    expect(f.runtime.view()).toMatchObject({ busy: false, connected: false, enabled: false })
    expect(f.persisted.at(-1)?.auto).toBe(false)
  })

  it('closes the peer when sign-in cancellation fails and clears the pending attempt', async () => {
    const f = fixture(); await f.runtime.login(true)
    f.setReply(async () => { throw new Error('Private fixture native diagnostic') })
    await expect(f.runtime.cancel()).rejects.toThrow(/backend was closed/)
    expect(f.closed).toBe(1)
    expect(f.runtime.view().busy).toBe(false)
  })

  it('keeps failed sign-in notifications sanitized and ignores another attempt identity', async () => {
    const f = fixture(); await f.runtime.login(true)
    f.emit('account/login/completed', { loginId: 'another', success: false })
    expect(f.runtime.view().busy).toBe(true)
    f.emit('account/login/completed', { loginId: 'fixture-login', success: false })
    expect(f.runtime.view()).toMatchObject({ busy: false, error: 'Codex sign-in did not complete. Try again.' })
  })
})

describe('Codex synthetic turn lifecycle', () => {
  it('refuses an unsigned account and malformed native thread/turn identities', async () => {
    for (const failure of ['account', 'thread', 'turn']) {
      const f = fixture()
      f.setReply(async (method) => {
        if (method === 'account/read') return { account: failure === 'account' ? null : { type: 'chatgpt' } }
        if (method === 'thread/start') return { thread: { id: failure === 'thread' ? '' : 'fixture-thread' } }
        return {}
      })
      await expect(collect(f.runtime)).rejects.toThrow(failure === 'account' ? /Sign in/ : failure === 'thread' ? /invalid thread/ : /invalid turn/)
      expect(f.runtime.view().running).toBe(0)
    }
  })

  it.each(['failed', 'interrupted'])('returns a sanitized terminal finish for %s native turns', async (status) => {
    const f = fixture(); f.finishOnStart(() => { f.complete(status) })
    expect((await collect(f.runtime)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CODEX_TURN_FAILED',
      message: status === 'interrupted' ? 'Codex turn was interrupted.' : 'Codex turn failed. Refresh the backend or check account access.' } } })
    expect(f.runtime.view().running).toBe(0)
  })

  it('assembles native blocks and finite usage while ignoring unrelated turns and invalid usage', async () => {
    const f = fixture()
    f.finishOnStart(() => {
      f.emit('item/agentMessage/delta', { threadId: 'other', turnId: 'fixture-turn', itemId: 'wrong', delta: 'Wrong thread' })
      f.emit('item/agentMessage/delta', { threadId: 'fixture-thread', turnId: 'old-turn', itemId: 'wrong', delta: 'Wrong turn' })
      f.emit('thread/tokenUsage/updated', { threadId: 'fixture-thread', tokenUsage: { last: { inputTokens: -1, outputTokens: 2 } } })
      f.emit('thread/tokenUsage/updated', { threadId: 'fixture-thread', tokenUsage: { last: { inputTokens: 20, cachedInputTokens: 4, cacheWriteInputTokens: 3, outputTokens: 2 } } })
      f.emit('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: 'first', type: 'agentMessage', text: 'Complete block' } })
      f.emit('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: 'first', type: 'agentMessage', text: 'Duplicate block' } })
      f.emit('item/agentMessage/delta', { threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'second', delta: 'One ' })
      f.emit('item/agentMessage/delta', { threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'second', delta: 'two' })
      f.emit('turn/completed', { threadId: 'fixture-thread', turn: { id: 'another', status: 'completed' } })
      f.complete()
    })
    const chunks = await collect(f.runtime)
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Complete block' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'One two' } },
    ])
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 13, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 3 } })
    expect(JSON.stringify(chunks)).not.toMatch(/Wrong|Duplicate/)
  })

  it('blocks backend changes while a turn is held and interrupts the exact turn after cancellation', async () => {
    const f = fixture(); const entered = Promise.withResolvers<undefined>()
    f.finishOnStart(() => { entered.resolve(undefined) })
    const abort = new AbortController(); const pending = collect(f.runtime, request({ signal: abort.signal }))
    const rejected = expect(pending).rejects.toThrow('Fixture cancelled')
    await entered.promise
    await expect(f.runtime.configure(false)).rejects.toThrow(/active Codex turn/)
    await expect(f.runtime.logout()).rejects.toThrow(/active Codex turn/)
    await expect(f.runtime.login(true)).rejects.toThrow(/active Codex operation/)
    await expect(collect(f.runtime)).rejects.toThrow(/active Codex operation/)
    abort.abort(new Error('Fixture cancelled')); await rejected
    expect(f.calls).toContainEqual({ method: 'turn/interrupt', params: { threadId: 'fixture-thread', turnId: 'fixture-turn' } })
    expect(f.runtime.view().running).toBe(0)
  })

  it.each(['__closed', 'overflow'])('refuses a turn whose transport reports %s', async (failure) => {
    const f = fixture(); f.finishOnStart(() => {
      if (failure === '__closed') f.emit('__closed')
      else for (let index = 0; index <= 4096; index++) f.emit('fixture/notification', { threadId: 'fixture-thread', turnId: 'fixture-turn' })
    })
    await expect(collect(f.runtime)).rejects.toThrow(failure === '__closed' ? /stopped before/ : /pending-event limit/)
    expect(f.runtime.view().running).toBe(0)
  })

  it('continues only an exact retained transcript and reseeds after instructions change', async () => {
    const f = fixture(); f.finishOnStart()
    const firstUser = createUserMessage({ content: [{ type: 'text', text: 'Fixture first' }], source: { kind: 'user' } })
    const sessionId = SessionId('fixture-retained')
    const first = await collect(f.runtime, request({ sessionId, messages: [firstUser] }))
    const finish = first.find(chunk => chunk.type === 'finish')
    if (finish?.type !== 'finish' || finish.replayState === undefined) throw new Error('Fixture turn did not retain a cursor')
    const assistant = createAssistantMessage({ content: [{ type: 'text', text: 'Fixture answer' }], source: { provider: 'codex-backend', model: model.id, replayState: finish.replayState } })
    const nextUser = createUserMessage({ content: [{ type: 'text', text: 'Fixture next' }], source: { kind: 'user' } })
    const messages = [firstUser, assistant, nextUser]
    await collect(f.runtime, request({ sessionId, messages }))
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'turn/start').at(-1)?.params).toMatchObject({ input: [{ type: 'text', text: 'Fixture next', text_elements: [] }] })
    await collect(f.runtime, request({ sessionId, messages, system: 'Different fixture instructions' }))
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(2)
  })

  it('invalidates overflowing native evidence and contains observer failures', async () => {
    const observed: SkillLearningNativeItem[] = []
    const f = fixture(undefined, { maximum: 1, observe(item) { observed.push(item); throw new Error('Fixture observer failure') } })
    f.finishOnStart(() => {
      for (const id of ['first', 'second', 'third']) f.emit('item/started', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id, type: 'webSearch' } })
      f.complete()
    })
    expect((await collect(f.runtime)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(observed.map(item => [item.itemId, item.phase])).toEqual([['first', 'started'], ['second', 'invalidated']])
  })

  it('rejects invalid native evidence budgets before creating any peer', () => {
    for (const maximum of [0, -1, 1.5, Number.NaN]) expect(() => fixture(undefined, { maximum, observe() {} })).toThrow(/item bound/)
  })

  it('quotes tool calls but omits reasoning and tool registry declarations from native history', () => {
    const message = createAssistantMessage({ source: { provider: 'codex-backend', model: model.id }, content: [
      { type: 'reasoning', text: 'Private fixture reasoning' },
      { type: 'tool-call', id: ToolCallId('fixture-call'), name: 'fixture-tool', arguments: '{"value":1}' },
      { type: 'tool-removal', toolName: 'fixture-tool' },
    ] })
    expect(projectCodexHistory([message])).toEqual([{ role: 'assistant', text: '{"tool":"fixture-tool","arguments":"{\\"value\\":1}"}', images: [] }])
  })
})
