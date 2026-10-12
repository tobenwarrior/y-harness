/** Real durable Decision restart images; only generation and failed settlement are fixtures. */
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DecisionAdvisory } from '../src/decision.ts'
import type { DecisionBounds, DecisionStore } from '../src/decision.ts'
import { decisionDomain } from '../src/decision-record.ts'
import type { SkillLibraryId, SkillLibraryItem } from '../src/types.ts'

const contexts = new Set<Context>()
const services = new Set<DecisionAdvisory>()
const roots: string[] = []
afterEach(async () => {
  for (const service of services) await service.dispose()
  services.clear()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

class FixtureAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  gate?: Promise<void>
  override providerInfo(provider: string) { return { id: provider, name: 'Fixture only', auxiliaryGeneration: 'api' as const } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    await this.gate
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"state":"selected","ids":["two"]}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const candidates = ['one', 'two'].map(name => ({ id: brandString<SkillLibraryId>(name), name, description: 'Release checks' })) as SkillLibraryItem[]
const bounds: DecisionBounds = {
  maxInputBytes: 8000, maxInputTokens: 8000, maxOutputBytes: 4000, maxOutputTokens: 1000,
  maxOutputChunks: 30, timeoutMs: 10_000, maxPending: 2, maxRecords: 1,
}
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-decision-recovery-'))
  roots.push(root)
  return root
}
async function open(root: string) {
  const ctx = new Context(); contexts.add(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root })
  await ctx.plugin(Domain, { backend: 'json' })
  await ctx.plugin(Llm)
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const log = await ctx.storageDomain.open(decisionDomain)
  const store: DecisionStore = { configuration: log.global, records: log.table('requests') }
  const create = () => {
    const service = new DecisionAdvisory(ctx, store, bounds)
    services.add(service)
    return service
  }
  return { ctx, adapter, log, store, create }
}
async function unsettled(root: string) {
  const f = await open(root)
  const service = f.create()
  await service.configure({ expectedRevision: 0, enabled: true, route: { provider: 'fixture', model: 'small' } })
  const put = f.store.records.put.bind(f.store.records)
  const failure = vi.spyOn(f.store.records, 'put').mockImplementation(async (key, value) => {
    if (value.outcome !== 'pending') throw new Error('Fixture result settlement was interrupted')
    await put(key, value)
  })
  try {
    expect(await service.select({ query: 'Release' }, candidates)).toEqual(candidates)
    expect(f.adapter.calls).toHaveLength(1)
    const record = [...f.store.records.entries()][0]!
    expect(record[1].outcome).toBe('pending')
    await service.dispose(); services.delete(service)
    await f.ctx.fiber.dispose(); contexts.delete(f.ctx)
    return record
  } finally { failure.mockRestore() }
}

describe('Decision durable restart settlement', () => {
  it('retains an interrupted request without replay and recovers bounded admission', async () => {
    const root = await freshRoot()
    const [id, interrupted] = await unsettled(root)
    const f = await open(root); const service = f.create()
    await service.status()
    expect(f.adapter.calls).toHaveLength(0)
    expect(f.store.records.get(id)).toEqual({ ...interrupted, outcome: 'abstained', reason: 'interrupted-before-settlement' })
    await service.dispose(); services.delete(service)
    await f.ctx.fiber.dispose(); contexts.delete(f.ctx)
    const reopened = await open(root)
    expect(reopened.store.records.get(id)).toEqual({ ...interrupted, outcome: 'abstained', reason: 'interrupted-before-settlement' })
    const resumed = reopened.create()
    expect((await resumed.select({ query: 'A new release query' }, candidates)).map(row => row.id)).toEqual(['two', 'one'])
    expect(reopened.adapter.calls).toHaveLength(1)
    expect(reopened.adapter.calls[0]!.messages[0]!.content).toEqual([{ type: 'text', text: JSON.stringify({ query: 'A new release query', candidates: [{ id: 'one', name: 'one', description: 'Release checks' }, { id: 'two', name: 'two', description: 'Release checks' }] }) }])
    expect(reopened.store.records.size).toBe(1)
    expect([...reopened.store.records.entries()][0]![1].outcome).toBe('selected')
  })

  it('refuses new dispatch after failed interruption durability even when the medium is repaired', async () => {
    const root = await freshRoot()
    const [id] = await unsettled(root)
    const f = await open(root)
    const path = join(root, 'skill_decision.json'); const backup = join(root, 'retained.json')
    await rename(path, backup); await mkdir(path)
    const service = f.create()
    let restored = false
    try {
      await expect(service.status()).rejects.toThrow()
      expect(await service.select({ query: 'Release' }, candidates)).toEqual(candidates)
      expect(f.adapter.calls).toHaveLength(0)
      expect(f.store.records.get(id)!.outcome).toBe('pending')
      await rm(path, { recursive: true }); await rename(backup, path)
      restored = true
      expect(await service.select({ query: 'Release again' }, candidates)).toEqual(candidates)
      expect(f.adapter.calls).toHaveLength(0)
      expect(f.store.records.get(id)!.outcome).toBe('pending')
    } finally {
      if (!restored) {
        await rm(path, { recursive: true, force: true })
        await rename(backup, path)
      }
    }
  })

  it('leaves a current live request pending across status reads and concurrent admission', async () => {
    const f = await open(await freshRoot()); const service = f.create()
    await service.configure({ expectedRevision: 0, enabled: true, route: { provider: 'fixture', model: 'small' } })
    let release: () => void = () => { }
    f.adapter.gate = new Promise<void>((resolve) => { release = resolve })
    const first = service.select({ query: 'Release' }, candidates)
    try {
      await vi.waitFor(() => { expect(f.adapter.calls).toHaveLength(1) })
      const [id] = [...f.store.records.entries()][0]!
      await service.status()
      expect(await service.select({ query: 'Concurrent release' }, candidates)).toEqual(candidates)
      expect(f.store.records.get(id)!.outcome).toBe('pending')
      expect(f.adapter.calls).toHaveLength(1)
      release()
      expect((await first).map(row => row.id)).toEqual(['two', 'one'])
      expect(f.store.records.get(id)!.outcome).toBe('selected')
    } finally { release(); await first }
  })

  it('waits for an in-flight interruption write on disposal and cancels waiting advice without dispatch', async () => {
    const root = await freshRoot()
    const [id] = await unsettled(root)
    const f = await open(root)
    let release: () => void = () => { }; let entered = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const update = f.store.records.update.bind(f.store.records)
    const delayed = vi.spyOn(f.store.records, 'update').mockImplementation(async (key, change) => {
      entered = true
      await gate
      return update(key, change)
    })
    const service = f.create()
    try {
      await vi.waitFor(() => { expect(entered).toBe(true) })
      const controller = new AbortController()
      const advice = service.select({ query: 'Cancelled while recovering' }, candidates, controller.signal)
      controller.abort()
      expect(await advice).toEqual(candidates)
      expect(f.adapter.calls).toHaveLength(0)
      let disposed = false
      const disposal = service.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(f.store.records.get(id)!.outcome).toBe('pending')
      release(); await disposal; services.delete(service)
      expect(disposed).toBe(true)
      expect(f.store.records.get(id)!.outcome).toBe('abstained')
      const snapshot = JSON.stringify([...f.store.records.entries()])
      await Promise.resolve()
      expect(JSON.stringify([...f.store.records.entries()])).toBe(snapshot)
      expect(f.adapter.calls).toHaveLength(0)
    } finally { release(); delayed.mockRestore() }
  })
})
