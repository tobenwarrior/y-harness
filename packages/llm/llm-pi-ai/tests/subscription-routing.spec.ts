import { afterEach, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { catalogModels } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
afterEach(() => { vi.unstubAllGlobals(); seen.splice(0) })
function captureRequests(): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    seen.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) as Record<string, unknown> })
    return Response.json({ error: { message: 'Mock authorization refusal', type: 'authentication_error' } }, { status: 401 })
  })
}
it.each([
  ['openai-completions', '/zen/go/v1/chat/completions'],
  ['openai-responses', '/zen/go/v1/responses'],
  ['anthropic-messages', '/zen/go/v1/messages'],
])('sends OpenCode Go %s with its own endpoint and conversation attribution', async (api, path) => {
  captureRequests()
  const model = [...catalogModels('opencode-go').values()].find(model => model.api === api)!
  expect(model).toBeDefined()
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ 'opencode-go': {} }), resolveApiKey: async () => 'mock-go-key', auth: memoryAuth() })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'opencode-go', model: model.id, messages: [], sessionId: 'mock-conversation' as never })) chunks.push(chunk)
  expect(seen).toHaveLength(1)
  const target = new URL(seen[0]!.url)
  expect(target.origin + target.pathname).toBe(`https://opencode.ai${path}`)
  // The native Anthropic beta client adds its standard query flag; routing
  // is defined by the origin/path, while the installed SDK owns this flag.
  expect(target.searchParams.get('beta')).toBe(api === 'anthropic-messages' ? 'true' : null)
  expect(seen[0]!.headers.get('x-opencode-session')).toBe('mock-conversation')
  expect(seen[0]!.headers.get('user-agent')).toMatch(/deepseek|dsh/i)
  expect(seen[0]!.body.model).toBe(model.id)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
})
it('sends ChatGPT OAuth to public Responses with required stream/store flags', async () => {
  captureRequests()
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ chatgpt: { api: 'openai-responses', models: [{ id: 'account-model' }] } }),
    resolveApiKey: async () => undefined, auth: memoryAuth({ chatgpt: { type: 'oauth', access: 'mock-oauth', refresh: 'mock-refresh', expires: Date.now() + 3_600_000 } }) })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'chatgpt', model: 'account-model', messages: [] })) chunks.push(chunk)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.url).toBe('https://api.openai.com/v1/responses')
  expect(seen[0]!.headers.get('authorization')).toBe('Bearer mock-oauth')
  expect(seen[0]!.body).toMatchObject({ model: 'account-model', stream: true, store: false, input: [] })
  expect(seen[0]!.body.service_tier).toBeUndefined()
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
})
it('refuses routing ChatGPT subscription credentials to custom endpoints or API-key overrides', () => {
  expect(() => resolveProfiles({ chatgpt: { api: 'openai-responses', baseURL: 'https://other.example/v1', models: [{ id: 'x' }] } })).toThrow('public Responses')
  expect(() => resolveProfiles({ chatgpt: { api: 'openai-responses', apiKeyEnv: 'OTHER_KEY', models: [{ id: 'x' }] } })).toThrow('sign-in')
})


it('adapts function tools and omits fields disallowed by the documented ChatGPT preview', async () => {
  captureRequests()
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ chatgpt: { api: 'openai-responses', models: [{ id: 'account-model' }] } }),
    resolveApiKey: async () => undefined, auth: memoryAuth({ chatgpt: { type: 'oauth', access: 'mock-oauth', refresh: 'mock-refresh', expires: Date.now() + 3_600_000 } }) })
  for await (const _chunk of adapter.stream({ provider: 'chatgpt', model: 'account-model', messages: [], system: 'Use the available tools.', temperature: 0.5, maxTokens: 1000,
    tools: [{ name: 'echo', description: 'Return input', parameters: { type: 'object', properties: { text: { type: 'string' } } } }] })) {}
  const body = seen[0]!.body
  expect(body.temperature).toBeUndefined()
  expect(body.max_output_tokens).toBeUndefined()
  expect(body.prompt_cache_retention).toBeUndefined()
  expect(body.tools).toMatchObject([{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'echo' }] }])
  expect(body.input).toMatchObject([{ role: 'developer' }])
})

it.each(['low', 'medium', 'high', 'xhigh', 'max'])('preserves the exact ChatGPT %s effort and per-model Fast tier', async (effort) => {
  captureRequests()
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ chatgpt: { api: 'openai-responses', models: [{ id: 'gpt-5.6-sol',
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Increased usage' }], serviceTier: 'priority' }] } }),
  resolveApiKey: async () => undefined, auth: memoryAuth({ chatgpt: { type: 'oauth', access: 'mock-oauth', refresh: 'mock-refresh', expires: Date.now() + 3_600_000 } }) })
  for await (const _chunk of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.6-sol', reasoningEffort: ReasoningEffortId(effort), messages: [] })) {}
  expect(seen).toHaveLength(1)
  expect(seen[0]!.body).toMatchObject({ reasoning: { effort }, service_tier: 'priority' })
})
it('refuses an unavailable processing tier before authentication or inference', () => {
  captureRequests()
  expect(() => resolveProfiles({ chatgpt: { api: 'openai-responses', models: [{ id: 'gpt-daybreak-blue-latest', serviceTiers: [], serviceTier: 'priority' }] } })).toThrow('not advertised')
  expect(seen).toEqual([])
})
it('never maps Ultra into Max or silently falls back to another effort', async () => {
  captureRequests()
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ chatgpt: { api: 'openai-responses', models: [{ id: 'gpt-5.6-sol', reasoningEfforts: { low: 'low', max: 'max' } }] } }),
    resolveApiKey: async () => undefined, auth: memoryAuth() })
  await expect(async () => { for await (const _chunk of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.6-sol', reasoningEffort: ReasoningEffortId('ultra'), messages: [] })) {} }).rejects.toThrow('does not support')
  expect(seen).toEqual([])
})

it('publishes every wire-supported effort and its advertised default in the native model picker', async () => {
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ chatgpt: { api: 'openai-responses', models: [{ id: 'gpt-5.6-sol',
    defaultReasoning: 'low', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }] } }),
  resolveApiKey: async () => undefined, auth: memoryAuth() })
  const info = await adapter.resolveModel('chatgpt', 'gpt-5.6-sol')
  expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(info.reasoning?.defaultEffort).toBe('low')
})
