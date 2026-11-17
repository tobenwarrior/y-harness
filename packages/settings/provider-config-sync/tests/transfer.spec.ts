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
      'invalid/route': { baseURL: 'https://example.org/v1' },
      'key-in-url': { baseURL: 'https://example.com/v1?token=fixture' },
      'new-provider': { displayName: 'New provider', api: 'openai-completions', baseURL: 'https://example.org/v1' },
    })
    const plan = planProviderCatalogCopy(source,
      settings({ 'already-configured': { apiKeyEnv: 'CLOUD_ONLY' } }, { 'inherited-in-cloud': { displayName: 'Cloud' } }))
    expect(plan.retained).toBe(2)
    expect(plan.skipped).toBe(4)
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

  it('treats omitted settings and settings without providers as empty catalogs', () => {
    const [namespace] = settings({}).namespaces
    const source = { namespaces: [{ ...namespace, user: {} }] }
    const destination = {
      writable: true,
      namespaces: [{ ns: 'llm-pi-ai', schema: namespace?.schema, revision: 0 }],
    }

    expect(planProviderCatalogCopy(source, destination)).toEqual({
      revision: 0, changes: [], retained: 0, skipped: 0,
    })
  })

  it('rejects malformed responses and provider settings before planning a write', () => {
    const [namespace] = settings({}).namespaces
    const invalidNamespace = {
      writable: true, namespaces: [{ ...namespace, value: { providers: ['fixture'] } }],
    }

    expect(() => planProviderCatalogCopy(null, settings({}))).toThrow('Invalid provider catalog response')
    expect(() => planProviderCatalogCopy(settings({}), { namespaces: {} })).toThrow('Invalid provider catalog response')
    expect(() => planProviderCatalogCopy(settings({}), invalidNamespace)).toThrow('Invalid provider catalog settings')
  })

  it('rejects a copy that exceeds the request size limit', () => {
    const models = Array.from({ length: 2_100 }, (_, index) => ({
      id: `fixture-model-${index}`.padEnd(512, 'x'),
    }))
    const source = settings({ 'large-catalog': { models } })

    expect(() => planProviderCatalogCopy(source, settings({}))).toThrow('Provider catalog copy exceeds the supported size')
  })
})
