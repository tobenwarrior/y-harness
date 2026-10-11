import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { buildProvider } from '../src/provider.ts'
import type { ProviderSpec } from '../src/provider.ts'
import { readNousModels } from '../src/nous-protocol.ts'
import { nousProvider } from '../src/nous-provider.ts'

afterEach(() => { vi.unstubAllGlobals() })
const route: ProviderSpec = { provider: 'nous', displayName: 'Fixture Nous', models: [], namesCredential: false }
const inference = 'https://inference-api.nousresearch.com/v1'

describe('programmatic provider catalog refusal boundaries', () => {
  it.each([
    { namesCredential: true }, { api: 'anthropic-messages' }, { baseURL: 'https://fixture.invalid/v1' },
  ])('refuses native Nous route overrides at direct provider construction: %j', (overrides) => {
    expect(() => buildProvider({ ...route, ...overrides })).toThrow(/native OAuth connection and verified inference route/)
  })

  it('accepts explicit native Nous protocol and endpoint facts without adding API-key authentication', () => {
    const provider = buildProvider({ ...route, api: 'openai-completions', baseURL: inference })
    expect(provider.auth.apiKey).toBeUndefined(); expect(provider.auth.oauth).toBeDefined()
    expect(provider.baseUrl).toBe(inference)
  })

  it.each([false, undefined, { low: 'low' }] as const)('refuses an unadvertised programmatic default effort: %j', (reasoningEfforts) => {
    expect(() => resolveProfiles({ fixture: { api: 'openai-completions', baseURL: 'https://fixture.invalid', models: [{
      id: 'fixture-model', defaultReasoning: 'high', ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    }] } })).toThrow('Default effort "high" is not advertised for fixture/fixture-model.')
  })

  it('retains the advertised configured default effort through resolved route metadata', () => {
    const resolved = resolveProfiles({ fixture: { api: 'openai-completions', baseURL: 'https://fixture.invalid', models: [{
      id: 'fixture-model', defaultReasoning: 'high', reasoningEfforts: { low: 'low', high: 'high' },
    }] } })
    expect(resolved.get('fixture')?.configuredReasoning.get('fixture-model')).toBe('high')
  })

  it('withholds effort controls when an account catalog advertises only unsupported effort names', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'fixture-model',
      reasoning: { supported_efforts: ['ultra', 42, null] } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await readNousModels('synthetic-access', inference, new AbortController().signal)).toEqual([
      { id: 'fixture-model', name: 'fixture-model', reasoning: true },
    ])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retains unrelated template kwargs after removing unsupported reasoning controls', async () => {
    const requests: Request[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(new Request(input, init))
      return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Fixture"},"finish_reason":null}]}\n\n'
        + 'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
    })
    const model: Model<'openai-completions'> = { id: 'fixture-model', name: 'Fixture', provider: 'nous', api: 'openai-completions',
      baseUrl: inference, reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const context = normalizeContext({ messages: [{ role: 'user', content: 'Synthetic fixture', timestamp: 1 }] })
    const result = await nousProvider().stream(model, context, { apiKey: 'synthetic-access', fetch, maxRetries: 0,
      samplingParams: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true, safe_option: 'fixture' } } }).result()
    expect(result.stopReason).toBe('stop'); expect(fetch).toHaveBeenCalledOnce()
    const body = await requests[0]?.json() as Record<string, unknown>
    expect(body.chat_template_kwargs).toEqual({ safe_option: 'fixture' })
  })
})
