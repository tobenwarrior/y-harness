import { describe, expect, it } from 'vitest'
import { planProviderCatalogCopy } from '../src/transfer.ts'

function settings(providers: Record<string, unknown>, base: Record<string, unknown> = {}, writable = true) {
  return {
    writable,
    namespaces: [{
      ns: 'llm-pi-ai', schema: { providers: { type: 'record' } }, revision: 7,
      base: { providers: base }, user: { providers }, value: { providers: { ...base, ...providers } },
    }],
  }
}

describe('copy provider model catalogs to Cloud', () => {
  it('adds portable routes with an empty Cloud-owned key reference', () => {
    const source = settings({ 'model-lab': {
      displayName: 'Model Lab', api: 'openai-completions', baseURL: 'https://example.com/v1',
      apiKeyEnv: 'MAC_ONLY', headers: { Authorization: 'fixture-secret' },
      models: [{ id: 'fixture-model', maxTokens: 2048, headers: { key: 'nested-fixture-secret' } }],
    } }, { 'base-only': { baseURL: 'https://example.org/v1' } })
    const plan = planProviderCatalogCopy(source, settings({}))
    expect(plan).toMatchObject({
      revision: 7, retained: 0, skipped: 0,
      changes: [{ op: 'set', path: ['providers', 'model-lab'], value: {
        displayName: 'Model Lab', api: 'openai-completions', baseURL: 'https://example.com/v1',
        models: [{ id: 'fixture-model', maxTokens: 2048 }],
      } }],
    })
    expect(plan).toHaveProperty('changes.0.value.apiKeyEnv', expect.stringMatching(/^YH_SYNC_UNCONFIGURED_[0-9A-F]{32}$/u))
    expect(JSON.stringify(plan)).not.toMatch(/MAC_ONLY|fixture-secret|base-only/u)
  })

  it('keeps Cloud routes and skips profiles whose sign-in or endpoints cannot be copied', () => {
    const source = settings({
      'already-configured': { baseURL: 'https://example.com/v2' },
      'inherited-in-cloud': { baseURL: 'https://example.com/v2' },
      nous: { displayName: 'Nous' },
      chatgpt: { displayName: 'ChatGPT' },
      'key-in-url': { baseURL: 'https://example.com/v1?token=fixture' },
      'new-provider': { displayName: 'New provider', api: 'openai-completions', baseURL: 'https://example.org/v1' },
    })
    const plan = planProviderCatalogCopy(source,
      settings({ 'already-configured': { apiKeyEnv: 'CLOUD_ONLY' } }, { 'inherited-in-cloud': { displayName: 'Cloud' } }))
    expect(plan.retained).toBe(2)
    expect(plan.skipped).toBe(3)
    expect(plan.changes.map(change => change.path)).toEqual([['providers', 'new-provider']])
  })

  it('requires a writable Cloud namespace with the same provider schema', () => {
    const source = settings({ 'new-provider': { displayName: 'New provider' } })
    const incompatible = settings({})
    incompatible.namespaces[0]!.schema.providers.type = 'different'
    for (const target of [incompatible, settings({}, {}, false), { writable: true, namespaces: [] }]) {
      expect(() => planProviderCatalogCopy(source, target)).toThrow()
    }
  })
})
