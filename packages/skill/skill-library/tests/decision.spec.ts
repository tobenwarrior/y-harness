/** Bounded metadata advice with native denial and deterministic fallback; no real model calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, ServiceTierId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillLibraryId, SkillLibraryItem } from '../src/types.ts'
import { DecisionAdvisory } from '../src/decision.ts'
import type { DecisionStore } from '../src/decision.ts'
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
  closed = 0
  override async resolveModel(provider: string, model: string) { await this.prepareDelay; return { provider, id: model, name: model, ...(this.controls ? { reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] }, serviceTiers: { tiers: [{ id: ServiceTierId('default'), name: 'Default' }] } } : {}) } }
  override providerInfo(provider: string) { return { id: provider, name: provider, auxiliaryGeneration: this.mode } }
  constructor(readonly mode: 'api' | 'native' = 'api') { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    try {
      await this.nextDelay
      if (this.wait) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => { resolve() }, { once: true }))
      if (this.tool) yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { this.closed++ }
  }
}
const candidates = ['one', 'two'].map(name => ({ id: brandString<SkillLibraryId>(name), name, description: 'Release checks' })) as SkillLibraryItem[]
async function fixture(mode: 'api' | 'native' = 'api', bounds = {}) {
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
  const service = new DecisionAdvisory(ctx, store, {
    maxInputBytes: 8000, maxInputTokens: 8000, maxOutputBytes: 4000, maxOutputTokens: 1000,
    maxOutputChunks: 30, timeoutMs: 100, maxPending: 2, maxRecords: 4, ...bounds,
  })
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
