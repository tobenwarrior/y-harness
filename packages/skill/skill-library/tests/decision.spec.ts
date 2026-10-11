/** Bounded metadata advice with native denial and deterministic fallback; no real model calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, ServiceTierId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillLibraryId, SkillLibraryItem } from '../src/types.ts'
import { DecisionAdvisory } from '../src/decision.ts'
import type { DecisionBounds, DecisionStore } from '../src/decision.ts'
import type { DecisionConfiguration, DecisionRecord } from '../src/decision-types.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
class Adapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  reply = '{"state":"selected","ids":["two"]}'
  tool = false
  wait = false
  controls = false
  prepareDelay?: Promise<void>
  nextDelay?: Promise<void>
  chunks?: readonly StreamChunk[]
  closed = 0
  override async resolveModel(provider: string, model: string) { await this.prepareDelay; return { provider, id: model, name: model, ...(this.controls ? { reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] }, serviceTiers: { tiers: [{ id: ServiceTierId('default'), name: 'Default' }] } } : {}) } }
  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: provider, auxiliaryGeneration: this.mode } }
  constructor(readonly mode: 'api' | 'native' = 'api') { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    try {
      await this.nextDelay
      if (this.wait) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => { resolve() }, { once: true }))
      if (this.chunks !== undefined) { for (const chunk of this.chunks) yield chunk; return }
      if (this.tool) yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { this.closed++ }
  }
}
const candidates = ['one', 'two'].map(name => ({ id: brandString<SkillLibraryId>(name), name, description: 'Release checks' })) as SkillLibraryItem[]
const defaultBounds: DecisionBounds = {
  maxInputBytes: 8000, maxInputTokens: 8000, maxOutputBytes: 4000, maxOutputTokens: 1000,
  maxOutputChunks: 30, timeoutMs: 100, maxPending: 2, maxRecords: 4,
}
async function fixture(mode: 'api' | 'native' = 'api', bounds: Partial<DecisionBounds> = {}) {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(LlmRuntime)
  const adapter = new Adapter(mode); const registration = ctx.llm.registerAdapter(['fixture'], adapter)
  let config: DecisionConfiguration = { enabled: false, revision: 0 }
  const records = new Map<string, DecisionRecord>()
  const store: DecisionStore = {
    configuration: { get: () => config, set: async (value) => { config = value } },
    records: {
      get: key => records.get(key), put: async (key, value) => { records.set(key, value) },
      delete: async key => records.delete(key), entries: () => records.entries(), keys: () => records.keys(),
      get size() { return records.size },
      update: async (key, fn) => {
        const current = records.get(key)
        if (current === undefined) throw new Error('Decision fixture record does not exist')
        const next = fn(current); records.set(key, next); return next
      },
    },
  }
  const service = new DecisionAdvisory(ctx, store, { ...defaultBounds, ...bounds })
  const run = () => service.select({ query: 'Release', explicitIds: [] }, candidates)
  return { ctx, adapter, registration, records, store, service, run, enable: () => service.configure({ expectedRevision: 0, enabled: true, route: { provider: 'fixture', model: 'small' } }) }
}
function barrier() {
  let release: () => void = () => { }
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
describe('Decision advice', () => {
  it('starts disabled, preserves baseline, and never executes native tools', async () => {
    const f = await fixture('native'); expect(await f.run()).toEqual(candidates)
    await expect(f.enable()).rejects.toThrow('response-only')
    expect(f.adapter.calls).toHaveLength(0); await f.service.dispose()
  })
  it('persists a separate revision, logs complete requests, and ranks only admitted candidates', async () => {
    const f = await fixture(); const value = await f.enable(); expect(value.revision).toBe(1)
    await expect(f.service.configure({ expectedRevision: 0, enabled: false })).rejects.toThrow('revision')
    expect((await f.run()).map(row => row.id)).toEqual(['two', 'one'])
    expect(f.adapter.calls[0]).toMatchObject({ provider: 'fixture', model: 'small', tools: [], purpose: 'skill-decision', maxTokens: 1000 })
    const record = [...f.records.values()][0]!
    expect(JSON.parse(record.input)).toMatchObject({ tools: [], purpose: 'skill-decision' })
    expect(record).toMatchObject({ outcome: 'selected', selectedIds: ['two'] }); await f.service.dispose()
  })
  it.each(['{"state":"selected","ids":["outside"]}', '{"state":"selected","ids":["two","two"]}', '{"state":"abstain","ids":[]}', 'no JSON', '{"state":"selected","ids":["two"],"verified":true}'])('falls back on rejection or invalid output %s', async (reply) => {
    const f = await fixture(); await f.enable(); f.adapter.reply = reply
    expect(await f.run()).toEqual(candidates); expect([...f.records.values()][0]!.outcome).toBe('abstained'); await f.service.dispose()
  })
  it('preserves explicit candidates and abstains on tool chunks and route withdrawal', async () => {
    const f = await fixture(); await f.enable()
    expect((await f.service.select({ query: 'Release', explicitIds: [candidates[0]!.id] }, candidates))[0]!.id).toBe('one')
    f.adapter.tool = true; expect(await f.run()).toEqual(candidates)
    f.registration(); expect(await f.run()).toEqual(candidates); expect(f.adapter.calls).toHaveLength(2); await f.service.dispose()
  })
  it('bounds the full framed input, output chunks, deadline, and concurrent admission', async () => {
    const tiny = await fixture('api', { maxInputBytes: 1 }); await tiny.enable(); expect(await tiny.run()).toEqual(candidates); expect(tiny.adapter.calls).toHaveLength(0); await tiny.service.dispose()
    const output = await fixture('api', { maxOutputBytes: 1 }); await output.enable(); expect(await output.run()).toEqual(candidates); await output.service.dispose()
    const f = await fixture('api', { timeoutMs: 10, maxPending: 1 }); await f.enable(); f.adapter.wait = true
    const pending = f.run(); expect(await f.run()).toEqual(candidates); expect(await pending).toEqual(candidates)
    expect(f.adapter.calls).toHaveLength(1); await f.service.dispose()
  })
  it('requires explicit supported effort/tier and does not inherit adapter defaults', async () => {
    const f = await fixture(); f.adapter.controls = true
    await expect(f.enable()).rejects.toThrow('explicit supported reasoning')
    await expect(f.service.configure({ expectedRevision: 0, enabled: true, route: { provider: 'fixture', model: 'small', reasoningEffort: ReasoningEffortId('low') } })).rejects.toThrow('explicit supported processing')
    await f.service.configure({ expectedRevision: 0, enabled: true, route: { provider: 'fixture', model: 'small', reasoningEffort: ReasoningEffortId('low'), serviceTier: ServiceTierId('default') } })
    await f.run(); expect(f.adapter.calls[0]).toMatchObject({ reasoningEffort: 'low', serviceTier: 'default' }); await f.service.dispose()
  })
  it('aborts in-flight API registrations on replacement and honors caller cancellation', async () => {
    const f = await fixture(); await f.enable(); f.adapter.wait = true
    const pending = f.run(); await Promise.resolve(); f.registration.replace(['fixture'])
    expect(await pending).toEqual(candidates)
    const controller = new AbortController(); const cancelled = f.service.select({ query: 'release' }, candidates, controller.signal); controller.abort()
    expect(await cancelled).toEqual(candidates); await f.service.dispose()
  })
  it('caps retained calls and never gives response fields authority', async () => {
    const f = await fixture('api', { maxRecords: 2 }); await f.enable()
    for (let i = 0; i < 4; i++) await f.run()
    expect(f.records.size).toBe(2)
    f.adapter.reply = '{"state":"selected","ids":["two"],"permission":"allow"}'
    expect(await f.run()).toEqual(candidates); expect([...f.records.values()].every(row => !('permission' in row))).toBe(true); await f.service.dispose()
  })
  it('waits for timed-out underlying preparation before disposal and never dispatches it late', async () => {
    const f = await fixture('api', { timeoutMs: 10 }); await f.enable(); const gate = barrier(); f.adapter.prepareDelay = gate.promise
    expect(await f.run()).toEqual(candidates)
    let disposed = false; const disposal = f.service.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false); gate.release(); await disposal
    expect(disposed).toBe(true); expect(f.adapter.calls).toHaveLength(0); expect(f.records.size).toBe(0)
  })
  it('retains the admission slot across repeated deadlines until preparation settles', async () => {
    const f = await fixture('api', { timeoutMs: 10, maxPending: 1 }); await f.enable()
    const gate = barrier(); let active = 0; let preparations = 0
    const prepare = f.ctx.llm.prepareCall.bind(f.ctx.llm)
    vi.spyOn(f.ctx.llm, 'prepareCall').mockImplementation(async (...args) => {
      active++; preparations++
      try { await gate.promise; return await prepare(...args) } finally { active-- }
    })
    try {
      for (let i = 0; i < 3; i++) expect(await f.run()).toEqual(candidates)
      expect({ active, preparations }).toEqual({ active: 1, preparations: 1 })
      let disposed = false; const disposal = f.service.dispose().then(() => { disposed = true })
      await Promise.resolve(); expect(disposed).toBe(false)
      gate.release(); await disposal
      expect(active).toBe(0); expect(f.adapter.calls).toHaveLength(0); expect(f.records.size).toBe(0)
    } finally { gate.release(); await f.service.dispose() }
  })
  it('waits for durable writes and settles abstention before closing after a timeout', async () => {
    const f = await fixture('api', { timeoutMs: 10 }); await f.enable(); const gate = barrier(); let writing = false
    const put = f.store.records.put.bind(f.store.records)
    f.store.records.put = async (key, value) => { writing = true; await gate.promise; await put(key, value) }
    const result = f.run(); await vi.waitFor(() => { expect(writing).toBe(true) }); expect(await result).toEqual(candidates)
    let disposed = false; const disposal = f.service.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false); gate.release(); await disposal
    expect([...f.records.values()][0]!.outcome).toBe('abstained'); expect(f.adapter.calls).toHaveLength(0)
    const snapshot = JSON.stringify([...f.records]); await Promise.resolve(); expect(JSON.stringify([...f.records])).toBe(snapshot)
  })
  it('returns fallback at the deadline while awaiting actual iterator return during disposal', async () => {
    const f = await fixture('api', { timeoutMs: 10 }); await f.enable(); const gate = barrier(); f.adapter.nextDelay = gate.promise
    expect(await f.run()).toEqual(candidates)
    let disposed = false; const disposal = f.service.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false); expect(f.adapter.closed).toBe(0)
    gate.release(); await disposal; expect(f.adapter.closed).toBe(1); expect([...f.records.values()][0]!.outcome).toBe('abstained')
  })
  it('reserves capped durable log capacity before concurrent dispatch', async () => {
    const f = await fixture('api', { timeoutMs: 20, maxRecords: 1, maxPending: 2 }); await f.enable(); f.adapter.wait = true
    const one = f.run(); const two = f.run(); expect(await one).toEqual(candidates); expect(await two).toEqual(candidates)
    expect(f.records.size).toBe(1); expect(f.adapter.calls).toHaveLength(1); await f.service.dispose()
  })
})


it('reports API catalogs, native or undeclared routes, and catalog failures without generation', async () => {
  const f = await fixture()
  vi.spyOn(f.adapter, 'listModels').mockResolvedValue([{ provider: 'fixture', id: 'small', name: 'Small' }])
  expect((await f.service.status()).models).toEqual([{ provider: 'fixture', model: 'small', name: 'Small', available: true, reason: 'response-only' }])
  expect(f.adapter.calls).toEqual([])
  vi.spyOn(f.adapter, 'providerInfo').mockReturnValue({ id: 'fixture', name: 'Fixture' }); f.registration.replace(['fixture'])
  expect((await f.service.status()).models[0]?.reason).toBe('undeclared')
  vi.spyOn(f.adapter, 'providerInfo').mockReturnValue({ id: 'fixture', name: 'Fixture', auxiliaryGeneration: 'native' }); f.registration.replace(['fixture'])
  expect((await f.service.status()).models[0]?.reason).toBe('native-tools')
  vi.spyOn(f.adapter, 'providerInfo').mockReturnValue({ id: 'fixture', name: 'Fixture', auxiliaryGeneration: 'api' }); f.registration.replace(['fixture'])
  vi.spyOn(f.adapter, 'listModels').mockRejectedValue(new Error('Catalog unavailable'))
  expect((await f.service.status()).models[0]?.reason).toBe('unavailable')
  await f.service.dispose()
  expect((await f.service.status()).models).toEqual([])
})
it('requires a route for enablement and permits route-free disablement', async () => {
  const f = await fixture()
  await expect(f.service.configure({ expectedRevision: 0, enabled: true })).rejects.toThrow(/requires.*route/)
  expect(await f.service.configure({ expectedRevision: 0, enabled: false })).toEqual({ revision: 1, enabled: false })
  expect(f.adapter.calls).toEqual([]); await f.service.dispose()
})
const normalText: StreamChunk = { type: 'block-end', index: 0, block: { type: 'text', text: '{"state":"selected","ids":["two"]}' } }
const normalFinish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
it.each([
  { chunks: [normalText, normalFinish, normalFinish], reason: 'incomplete-response' },
  { chunks: [normalText, normalFinish, normalText], reason: 'incomplete-response' },
  { chunks: [normalText], reason: 'incomplete-response' },
  { chunks: [normalText, { type: 'finish', reason: { kind: 'max-tokens' } }], reason: 'incomplete-response' },
  { chunks: [{ type: 'tool-call-delta', index: 0, id: ToolCallId('call'), argumentsDelta: '{}' }], reason: 'output-budget-or-tools' },
  { chunks: [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call'), name: 'exec', arguments: '{}' } }], reason: 'output-budget-or-tools' },
  { chunks: [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1001 } }], reason: 'token-budget' },
  { chunks: [{ type: 'usage', usage: { inputTokens: 8001, outputTokens: 1 } }], reason: 'token-budget' },
  { chunks: [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 8000, cacheWriteTokens: 1 } }], reason: 'token-budget' },
] as { chunks: StreamChunk[]; reason: string }[])('records bounded fallback for invalid stream $reason', async ({ chunks, reason }) => {
  const f = await fixture(); await f.enable(); f.adapter.chunks = chunks
  expect(await f.run()).toEqual(candidates); await f.service.dispose()
  expect([...f.records.values()][0]).toMatchObject({ outcome: 'abstained', reason })
  expect(f.adapter.closed).toBe(1); await f.service.dispose()
})
it('accepts final usage and reasoning while retaining candidate membership', async () => {
  const f = await fixture(); await f.enable()
  f.adapter.chunks = [{ type: 'block-end', index: 1, block: { type: 'reasoning', text: 'Compare metadata.' } }, normalText, normalFinish,
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }]
  expect((await f.run()).map(item => item.id)).toEqual(['two', 'one'])
  expect([...f.records.values()][0]?.outcome).toBe('selected'); await f.service.dispose()
})
it('rejects sensitive input, small token admission, excessive chunks, and complete output envelopes', async () => {
  const sensitive = await fixture(); await sensitive.enable()
  expect(await sensitive.service.select({ query: 'Authorization: Bearer synthetic' }, candidates)).toEqual(candidates)
  expect(sensitive.adapter.calls).toEqual([]); await sensitive.service.dispose()
  const input = await fixture('api', { maxInputTokens: 1 }); await input.enable()
  expect(await input.run()).toEqual(candidates); expect(input.adapter.calls).toEqual([]); await input.service.dispose()
  const chunks = await fixture('api', { maxOutputChunks: 1 }); await chunks.enable()
  expect(await chunks.run()).toEqual(candidates); await chunks.service.dispose()
  expect([...chunks.records.values()][0]?.reason).toBe('output-budget-or-tools'); await chunks.service.dispose()
  const output = await fixture(); await output.enable()
  output.adapter.chunks = [{ type: 'block-end', index: 1, block: { type: 'reasoning', text: 'Authorization: Bearer synthetic' } }, normalText, normalFinish]
  expect(await output.run()).toEqual(candidates)
  expect([...output.records.values()][0]?.reason).toBe('output-budget'); await output.service.dispose()
})

it.each(['reasoning', 'tier'] as const)('refuses a newly defaulted $0 control before API dispatch', async (control) => {
  const f = await fixture(); await f.enable()
  vi.spyOn(f.adapter, 'resolveModel').mockImplementation(async (provider, model) => ({
    provider, id: model, name: model,
    ...(control === 'reasoning'
      ? { reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') } }
      : { serviceTiers: { tiers: [{ id: ServiceTierId('default'), name: 'Default' }], defaultTier: ServiceTierId('default') } }),
  }))
  try {
    expect(await f.run()).toEqual(candidates)
    expect(f.adapter.calls).toEqual([]); expect(f.records.size).toBe(0)
  } finally { await f.service.dispose() }
})

it('reserves requested output tokens within a declared model context window before dispatch', async () => {
  const f = await fixture(); await f.enable()
  vi.spyOn(f.adapter, 'resolveModel').mockImplementation(async (provider, model) => ({
    provider, id: model, name: model, context: { contextWindow: defaultBounds.maxOutputTokens },
  }))
  try {
    expect(await f.run()).toEqual(candidates)
    expect(f.adapter.calls).toEqual([]); expect(f.records.size).toBe(0)
  } finally { await f.service.dispose() }
})

it('refuses a framed input record that exceeds the byte cap even when its request fits', async () => {
  const probe = await fixture(); await probe.enable()
  let inputBytes: number
  try {
    expect((await probe.run()).map(row => row.id)).toEqual(['two', 'one'])
    const [record] = probe.records.values(); expect(record).toBeDefined()
    inputBytes = Buffer.byteLength(record!.input)
    expect(Buffer.byteLength(JSON.stringify({ id: record!.id, createdAt: record!.createdAt,
      configurationRevision: record!.configurationRevision, input: record!.input, outcome: 'pending' }))).toBeGreaterThan(inputBytes)
  } finally { await probe.service.dispose() }
  const f = await fixture('api', { maxInputBytes: inputBytes }); await f.enable()
  try {
    expect(await f.run()).toEqual(candidates)
    expect(f.adapter.calls).toEqual([]); expect(f.records.size).toBe(0)
  } finally { await f.service.dispose() }
})

it('records route replacement after a request is durable and the API stream has started', async () => {
  const f = await fixture(); await f.enable(); const gate = barrier(); f.adapter.nextDelay = gate.promise
  try {
    const result = f.run()
    await vi.waitFor(() => { expect(f.adapter.calls).toHaveLength(1) })
    expect([...f.records.values()][0]?.outcome).toBe('pending')
    f.registration.replace(['fixture'])
    expect(await result).toEqual(candidates)
    gate.release(); await f.service.dispose()
    expect([...f.records.values()][0]).toMatchObject({ outcome: 'abstained', reason: 'route-changed' })
    expect(f.adapter.closed).toBe(1)
  } finally { gate.release(); await f.service.dispose() }
})

it('waits for outstanding catalog lookup to settle before disposal completes', async () => {
  const f = await fixture(); const entered = barrier(); const gate = barrier()
  vi.spyOn(f.adapter, 'listModels').mockImplementation(async () => { entered.release(); await gate.promise; return [] })
  try {
    const status = f.service.status(); await entered.promise
    let disposed = false
    const disposal = f.service.dispose().then(() => { disposed = true })
    expect((await status).models[0]?.reason).toBe('unavailable')
    expect(disposed).toBe(false)
    gate.release(); await disposal; expect(disposed).toBe(true)
    expect(f.adapter.calls).toEqual([])
  } finally { gate.release(); await f.service.dispose() }
})

it('retains deterministic fallback and durable abstention when result storage rejects with a non-Error', async () => {
  const f = await fixture(); await f.enable()
  const put = f.store.records.put.bind(f.store.records)
  vi.spyOn(f.store.records, 'put').mockImplementationOnce(put).mockRejectedValueOnce({ code: 'fixture-storage-unavailable' })
  try {
    expect(await f.run()).toEqual(candidates)
    expect([...f.records.values()][0]).toMatchObject({ outcome: 'abstained', reason: 'unavailable-or-invalid' })
  } finally { await f.service.dispose() }
})

it('keeps an already settled record when pending recovery reaches its queued update', async () => {
  const f = await fixture(); await f.enable(); await f.run(); await f.service.dispose()
  const [record] = f.records.values(); expect(record).toBeDefined()
  const pending: DecisionRecord = {
    id: record!.id, createdAt: record!.createdAt, configurationRevision: record!.configurationRevision,
    input: record!.input, outcome: 'pending',
  }
  await f.store.records.put(pending.id, pending)
  const entered = barrier(); const gate = barrier(); const update = f.store.records.update.bind(f.store.records)
  vi.spyOn(f.store.records, 'update').mockImplementation(async (key, transform) => {
    entered.release(); await gate.promise; return update(key, transform)
  })
  const recovered = new DecisionAdvisory(f.ctx, f.store, defaultBounds)
  try {
    await entered.promise
    await f.store.records.put(record!.id, record!)
    gate.release(); await recovered.status()
    expect([...f.records.values()]).toEqual([record])
    expect(f.adapter.calls).toHaveLength(1)
  } finally { gate.release(); await recovered.dispose() }
})

it('reports unavailable Decision models when no LLM runtime is registered', async () => {
  const f = await fixture(); const ctx = new Context(); contexts.push(ctx)
  const service = new DecisionAdvisory(ctx, f.store, defaultBounds)
  try {
    expect(await service.status()).toMatchObject({ configuration: { enabled: false, revision: 0 }, models: [] })
    expect(f.adapter.calls).toEqual([])
  } finally { await service.dispose(); await f.service.dispose() }
})

it('keeps an unacknowledged result pending without advice and recovers abstention on reopening', async () => {
  const f = await fixture(); await f.enable()
  const put = f.store.records.put.bind(f.store.records)
  vi.spyOn(f.store.records, 'put').mockImplementationOnce(put)
    .mockRejectedValueOnce(new Error('selected result could not be stored'))
    .mockRejectedValueOnce(new Error('fallback result could not be stored'))
  try {
    expect(await f.run()).toEqual(candidates)
    expect([...f.records.values()][0]?.outcome).toBe('pending')
  } finally { await f.service.dispose() }
  const recovered = new DecisionAdvisory(f.ctx, f.store, defaultBounds)
  try {
    await recovered.status()
    expect([...f.records.values()][0]).toMatchObject({ outcome: 'abstained', reason: 'interrupted-before-settlement' })
    expect(f.adapter.calls).toHaveLength(1)
  } finally { await recovered.dispose() }
})

it('ranks admitted candidates when retrieval has no explicit IDs', async () => {
  const f = await fixture(); await f.enable()
  try {
    expect((await f.service.select({ query: 'Release' }, candidates)).map(row => row.id)).toEqual(['two', 'one'])
    expect([...f.records.values()][0]).toMatchObject({ outcome: 'selected', selectedIds: ['two'] })
  } finally { await f.service.dispose() }
})
