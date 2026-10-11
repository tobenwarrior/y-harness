/** A durable configuration change while reserving advice cannot dispatch stale model work. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished } from 'vitest'
import { DecisionAdvisory, type DecisionStore } from '../src/decision.ts'
import type { DecisionConfiguration, DecisionRecord } from '../src/decision-types.ts'
import type { SkillLibraryId, SkillLibraryItem } from '../src/types.ts'

class AdvisoryAdapter extends LlmAdapter {
  calls = 0
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: provider, auxiliaryGeneration: 'api' } }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"state":"selected","ids":["second"]}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('revalidates the durable configuration revision after log admission and preserves deterministic candidates', async () => {
  const ctx = new Context(); await ctx.plugin(LlmRuntime)
  const adapter = new AdvisoryAdapter(); ctx.llm.registerAdapter(['fixture-advice'], adapter)
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  let configuration: DecisionConfiguration = { enabled: false, revision: 0 }
  const records = new Map<string, DecisionRecord>()
  const store: DecisionStore = {
    configuration: { get: () => configuration, set: async (value) => { configuration = value } },
    records: {
      get: key => records.get(key), keys: () => records.keys(), entries: () => records.entries(),
      get size() { return records.size }, delete: async key => records.delete(key),
      put: async (key, value) => {
        records.set(key, value)
        if (value.outcome === 'pending') { entered.resolve(undefined); await release.promise }
      },
      update: async (key, transform) => {
        const current = records.get(key)
        if (current === undefined) throw new Error('fixture record is absent')
        const next = transform(current); records.set(key, next); return next
      },
    },
  }
  const advisory = new DecisionAdvisory(ctx, store, { maxInputBytes: 8000, maxInputTokens: 8000,
    maxOutputBytes: 4000, maxOutputTokens: 1000, maxOutputChunks: 10, timeoutMs: 1000, maxPending: 1, maxRecords: 3 })
  onTestFinished(async () => { release.resolve(undefined); await advisory.dispose(); await ctx.fiber.dispose() })
  const baseline: readonly SkillLibraryItem[] = ['first', 'second'].map(name => ({
    id: brandString<SkillLibraryId>(name), name, description: 'Release procedure', provider: 'fixture', source: 'runtime',
    path: `fixture:${name}`, scope: 'shared', projectIds: [], ownership: 'protected', status: 'active', shadowed: false,
    pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true },
    contentHash: '', bodyBytes: 0, usage: { coverage: 'unknown', loadCount: 0 }, references: [],
    capabilities: { adopt: false, archive: false, restore: false, cleanup: false, native: false },
  }))
  await advisory.configure({ expectedRevision: 0, enabled: true, route: { provider: 'fixture-advice', model: 'small' } })
  const pending = advisory.select({ query: 'Release' }, baseline)
  await entered.promise
  // The public durable-store face admits a valid concurrently published revision, without mutating a captured typed value.
  await store.configuration.set({ ...configuration, revision: 2, enabled: false })
  release.resolve(undefined)
  expect(await pending).toBe(baseline)
  expect(adapter.calls).toBe(0)
  expect([...records.values()]).toMatchObject([{ configurationRevision: 1, outcome: 'abstained', reason: 'configuration-changed' }])
  expect(store.configuration.get()).toMatchObject({ revision: 2, enabled: false })
})
