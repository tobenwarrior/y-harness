import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModels, normalizeContext } from '@earendil-works/pi-ai'
import type { Credential, CredentialStore, Model, OpenAICompletionsOptions } from '@earendil-works/pi-ai'
import { nousProvider } from '../src/nous-provider.ts'
import * as protocol from '../src/nous-protocol.ts'
import type { NousGrant } from '../src/nous-protocol.ts'
import type { NousModelView } from '../src/nous-types.ts'

const context = normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] })
const model: Model<'openai-completions'> = {
  id: 'hermes-test', name: 'Hermes Test', provider: 'nous', api: 'openai-completions',
  baseUrl: 'https://inference-api.nousresearch.com/v1', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048,
  thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
  compat: { thinkingFormat: 'openrouter', openRouterRouting: { only: ['test-route'] }, vercelGatewayRouting: { only: ['test-route'] } },
}
const optional: NousModelView = {
  id: model.id, name: model.name, reasoning: true, reasoningMandatory: false,
  reasoningEfforts: { off: 'none', low: 'low', high: 'high' },
}
const approvedClientId = 'yharness-test'
function grant(overrides: Partial<NousGrant> = {}): NousGrant {
  return { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000,
    clientId: 'yharness-test', scope: 'inference:invoke', inferenceBaseURL: model.baseUrl, ...overrides }
}
function captureFetch() {
  const requests: Request[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    requests.push(new Request(input, init))
    return new Response('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"hermes-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","created":1,"model":"hermes-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  return { requests, fetch }
}
async function requestBody(request: Request): Promise<Record<string, unknown>> {
  return await request.json() as Record<string, unknown>
}
async function dispatch(profiles: NousModelView[], options: OpenAICompletionsOptions = {}) {
  const capture = captureFetch()
  const result = await nousProvider(profiles).stream(model, context, { apiKey: 'synthetic-access', fetch: capture.fetch, maxRetries: 0, ...options }).result()
  return { ...capture, result, body: capture.requests[0] ? await requestBody(capture.requests[0]) : undefined }
}
function memoryStore(initial: Credential) {
  let current: Credential | undefined = initial
  let queue: Promise<void> = Promise.resolve()
  const store: CredentialStore = {
    read: vi.fn(async () => current), list: vi.fn(async () => current ? [{ providerId: 'nous', type: current.type }] : []),
    modify: vi.fn<CredentialStore['modify']>(async (_id, fn) => {
      let release!: () => void
      const previous = queue
      queue = new Promise<void>((resolve) => { release = resolve })
      await previous
      try { const next = await fn(current); if (next !== undefined) current = next; return current } finally { release() }
    }),
    delete: vi.fn(async () => { current = undefined }),
  }
  return { store, read: () => current }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('No live network in this suite.')))))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('native Nous provider', () => {
  it('owns OAuth only and leaves account-visible models to settings', async () => {
    const provider = nousProvider([optional])
    expect(provider).toMatchObject({ id: 'nous', name: 'Nous Portal', baseUrl: model.baseUrl })
    expect(provider.getModels()).toEqual([])
    expect(provider.auth.apiKey).toBeUndefined()
    await expect(provider.auth.oauth!.login({ signal: new AbortController().signal, prompt: vi.fn(), notify: vi.fn() })).rejects.toThrow('Models settings')
  })

  it('dispatches Chat Completions and composes caller customization before sanitizing', async () => {
    const payload = Object.freeze({ model: model.id, messages: [], stream: true, provider: { only: ['other'] }, providerOptions: { gateway: { only: ['other'] } },
      tags: ['product=hermes-agent', 'client=hermes-client-v1'], temperature: 0.2, reasoning: { effort: 'high', exclude: true } })
    const onPayload = vi.fn(async () => payload)
    const { result, requests, body } = await dispatch([optional], { reasoningEffort: 'low', onPayload })
    expect(result.stopReason).toBe('stop')
    expect(result.content).toMatchObject([{ type: 'text', text: 'Hi' }])
    expect(requests[0]!.url).toBe(`${model.baseUrl}/chat/completions`)
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer synthetic-access')
    expect(onPayload).toHaveBeenCalledOnce()
    expect(body).toEqual({ model: model.id, messages: [], stream: true, temperature: 0.2, reasoning: { effort: 'high' } })
    expect(payload.provider).toEqual({ only: ['other'] })
    expect(payload.reasoning).toEqual({ effort: 'high', exclude: true })
  })

  it('keeps in-place caller edits when its hook returns undefined without mutating during sanitization', async () => {
    let seen: Record<string, unknown> | undefined
    const { body } = await dispatch([optional], { reasoningEffort: 'low', onPayload(payload) {
      seen = payload as Record<string, unknown>
      seen.temperature = 0.3
      seen.tags = ['product=hermes-agent']
    } })
    expect(body!.temperature).toBe(0.3)
    expect(body!.tags).toBeUndefined()
    expect(body!.provider).toBeUndefined()
    expect(body!.providerOptions).toBeUndefined()
    expect(seen!.tags).toEqual(['product=hermes-agent'])
  })

  it('strips OpenRouter attribution from model and caller headers', async () => {
    const capture = captureFetch()
    const input = { ...model, headers: { 'HTTP-Referer': 'https://hermes.example.test', 'X-Title': 'Hermes', 'x-model-safe': 'model' } }
    const result = await nousProvider([optional]).stream(input, context, { apiKey: 'synthetic-access', fetch: capture.fetch,
      headers: { 'http-referer': 'https://openrouter.example.test', 'X-OpenRouter-Title': 'Other', 'X-OpenRouter-Categories': 'cli-agent', 'X-OpenRouter-Cache': 'cache', 'x-safe': 'caller' } }).result()
    expect(result.stopReason).toBe('stop')
    for (const name of ['http-referer', 'x-title', 'x-openrouter-title', 'x-openrouter-categories', 'x-openrouter-cache']) expect(capture.requests[0]!.headers.has(name)).toBe(false)
    expect(capture.requests[0]!.headers.get('x-safe')).toBe('caller')
    expect(capture.requests[0]!.headers.get('x-model-safe')).toBe('model')
    expect(input.headers['X-Title']).toBe('Hermes')
  })

  it('prevents model and caller Authorization headers from overriding the resolved bearer', async () => {
    const capture = captureFetch()
    const input = { ...model, headers: { Authorization: 'Bearer model-override', 'x-model-safe': 'model' } }
    const headers = { aUtHoRiZaTiOn: 'Bearer caller-override', 'x-safe': 'caller' }
    const result = await nousProvider([optional]).stream(input, context, { apiKey: 'synthetic-access', fetch: capture.fetch, headers }).result()
    expect(result.stopReason).toBe('stop')
    expect(capture.requests[0]!.headers.get('authorization')).toBe('Bearer synthetic-access')
    expect(capture.requests[0]!.headers.get('x-model-safe')).toBe('model')
    expect(capture.requests[0]!.headers.get('x-safe')).toBe('caller')
    expect(input.headers.Authorization).toBe('Bearer model-override')
    expect(headers.aUtHoRiZaTiOn).toBe('Bearer caller-override')
  })

  it.each([{ profiles: [] }, { profiles: [{ ...optional, reasoning: false }] }])('omits reasoning when selected model metadata offers none', async ({ profiles }) => {
    const { body } = await dispatch(profiles, { reasoningEffort: 'high', samplingParams: {
      reasoning: { effort: 'high' }, reasoning_effort: 'high', thinking: { type: 'enabled' }, enable_thinking: true,
      thinking_budget: 500, thinking_token_budget: 500, thinking_budget_tokens: 500,
      chat_template_kwargs: {
        enable_thinking: true, preserve_thinking: true, thinking_budget: 500, thinking_token_budget: 500, thinking_budget_tokens: 500,
      }, chat_template_args: { enable_thinking: true },
    } })
    for (const field of ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget', 'thinking_token_budget', 'thinking_budget_tokens', 'chat_template_kwargs', 'chat_template_args']) expect(body![field]).toBeUndefined()
  })

  it('does not invent an enabled reasoning default or emit an implicit off value', async () => {
    const { body } = await dispatch([optional])
    expect(body!.reasoning).toBeUndefined()
  })

  it('preserves advertised effort wire values for streamSimple', async () => {
    const capture = captureFetch()
    const profile = { ...optional, reasoningEfforts: { off: 'none', high: 'maximum' } }
    const input = { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, high: 'maximum' } }
    const result = await nousProvider([profile]).streamSimple(input, context, { apiKey: 'synthetic-access', fetch: capture.fetch, reasoning: 'high' }).result()
    expect(result.stopReason).toBe('stop')
    expect((await requestBody(capture.requests[0]!)).reasoning).toEqual({ effort: 'maximum' })
  })

  it('permits explicit off only when the selected metadata advertises optional reasoning', async () => {
    const capture = captureFetch()
    const result = await nousProvider([optional]).streamSimple(model, context, { apiKey: 'synthetic-access', fetch: capture.fetch, samplingParams: { reasoning: { enabled: false } } }).result()
    expect(result.stopReason).toBe('stop')
    expect((await requestBody(capture.requests[0]!)).reasoning).toEqual({ enabled: false })
  })

  it.each([true, undefined])('omits disabling controls for mandatory or unknown optionality (%s)', async (reasoningMandatory) => {
    const { reasoningMandatory: _mandatory, ...metadata } = optional
    const { result, body } = await dispatch([{ ...metadata, ...reasoningMandatory === undefined ? {} : { reasoningMandatory } }], { samplingParams: { reasoning: { enabled: false, effort: 'none' } } })
    expect(result.stopReason).toBe('stop')
    expect(body!.reasoning).toBeUndefined()
  })

  it('omits an unadvertised off control even when reasoning is optional', async () => {
    const { body } = await dispatch([{ ...optional, reasoningEfforts: { low: 'low' } }], { samplingParams: { reasoning: { enabled: false } } })
    expect(body!.reasoning).toBeUndefined()
  })

  it('omits reasoning for a reasoning model with no advertised effort controls', async () => {
    const { reasoningEfforts: _efforts, ...metadata } = optional
    const { body } = await dispatch([metadata], { reasoningEffort: 'high' })
    expect(body!.reasoning).toBeUndefined()
  })

  it('projects an advertised top-level effort to the native nested format', async () => {
    const { body } = await dispatch([optional], { onPayload: payload => ({ ...payload as object, reasoning: undefined, reasoning_effort: 'high' }) })
    expect(body!.reasoning_effort).toBeUndefined()
    expect(body!.reasoning).toEqual({ effort: 'high' })
  })

  it('preserves an explicit advertised effort over the SDK implicit none control', async () => {
    const { body } = await dispatch([optional], { samplingParams: { reasoning_effort: 'high' } })
    expect(body!.reasoning_effort).toBeUndefined()
    expect(body!.reasoning).toEqual({ effort: 'high' })
  })

  it('preserves a hook effort over an unchanged clone of the SDK implicit none control', async () => {
    const { body } = await dispatch([optional], { onPayload: (payload) => {
      const source = payload as Record<string, unknown>
      return { ...source, reasoning: { ...source.reasoning as object }, reasoning_effort: 'high' }
    } })
    expect(body!.reasoning).toEqual({ effort: 'high' })
  })

  it('preserves a caller hook removing an explicit reasoning control', async () => {
    const { body } = await dispatch([optional], { reasoningEffort: 'low', onPayload: payload => ({ ...payload as object, reasoning: undefined }) })
    expect(body!.reasoning).toBeUndefined()
  })

  it('preserves a caller hook removing a top-level effort over the SDK implicit none', async () => {
    const { body } = await dispatch([optional], { samplingParams: { reasoning_effort: 'high' }, onPayload: payload => ({ ...payload as object, reasoning_effort: undefined }) })
    expect(body!.reasoning).toBeUndefined()
  })

  it('rejects an unadvertised option before the SDK can silently clamp it', async () => {
    const capture = captureFetch()
    const result = await nousProvider([optional]).streamSimple(model, context, { apiKey: 'synthetic-access', fetch: capture.fetch, reasoning: 'medium' }).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('advertised')
    expect(capture.requests).toHaveLength(0)
  })

  it('rejects a caller effort absent from advertised model metadata before inference', async () => {
    const { result, requests } = await dispatch([optional], { onPayload: payload => ({ ...payload as object, reasoning: { effort: 'ultra' } }) })
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('advertised')
    expect(requests).toHaveLength(0)
  })

  it.each([null, [], 'invalid'])('rejects payload replacement with a non-object before inference (%s)', async (replacement) => {
    const { result, requests } = await dispatch([optional], { onPayload: () => replacement })
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('request object')
    expect(requests).toHaveLength(0)
  })

  it('validates stored grants before deriving the bearer and retained inference URL', async () => {
    const oauth = nousProvider([], approvedClientId).auth.oauth!
    const stored = grant({ inferenceBaseURL: 'https://welcome-api.nousresearch.com/v1' })
    expect(await oauth.toAuth(stored)).toEqual({ apiKey: stored.access, baseUrl: stored.inferenceBaseURL })
    for (const malformed of [grant({ scope: 'profile' }), grant({ clientId: '' }), grant({ inferenceBaseURL: 'https://attacker.example.test/v1' }), { ...grant(), access: 4 }]) {
      await expect(oauth.toAuth(malformed as NousGrant)).rejects.toThrow()
    }
  })

  it('validates before refresh and delegates rotation with the request signal', async () => {
    const stored = grant({ expires: Date.now() - 1000 })
    const rotated = grant({ access: 'rotated-access', refresh: 'rotated-refresh' })
    const refresh = vi.spyOn(protocol, 'refreshNousGrant').mockResolvedValue(rotated)
    const signal = new AbortController().signal
    expect(await nousProvider([], approvedClientId).auth.oauth!.refresh(stored, signal)).toEqual(rotated)
    expect(refresh).toHaveBeenCalledWith(stored, signal)
    await expect(nousProvider([], approvedClientId).auth.oauth!.refresh(grant({ scope: 'profile' }), signal)).rejects.toThrow()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('uses the existing Models store lock to persist one rotation across concurrent auth requests', async () => {
    const rotated = grant({ access: 'rotated-access', refresh: 'rotated-refresh' })
    const refresh = vi.spyOn(protocol, 'refreshNousGrant').mockResolvedValue(rotated)
    const memory = memoryStore(grant({ expires: Date.now() - 1000 }))
    const models = createModels({ credentials: memory.store, authContext: { env: vi.fn(async () => 'synthetic-ambient'), fileExists: vi.fn(async () => false) } })
    models.setProvider(nousProvider([], approvedClientId))
    const auth = await Promise.all([models.getAuth('nous'), models.getAuth('nous')])
    expect(refresh).toHaveBeenCalledOnce()
    expect(memory.read()).toEqual(rotated)
    expect(auth.map(item => item!.auth.apiKey)).toEqual(['rotated-access', 'rotated-access'])
  })

  it('surfaces refresh errors without reading ambient credentials or sending inference', async () => {
    const original = grant({ expires: Date.now() - 1000 })
    vi.spyOn(protocol, 'refreshNousGrant').mockRejectedValue(new Error('Sign in again.'))
    const memory = memoryStore(original)
    const env = vi.fn(async () => 'synthetic-ambient')
    const models = createModels({ credentials: memory.store, authContext: { env, fileExists: vi.fn(async () => false) } })
    models.setProvider(nousProvider([], approvedClientId))
    await expect(models.getAuth('nous', { apiKey: 'synthetic-override' })).rejects.toThrow('Sign in again')
    expect(memory.read()).toEqual(original)
    expect(env).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each([{ scope: 'profile' }, { inferenceBaseURL: 'https://attacker.example.test/v1' }])('retains a successful token rotation when subsequent auth metadata is unsafe (%j)', async (unsafe) => {
    const rotated = grant({ access: 'rotated-access', refresh: 'rotated-refresh', ...unsafe })
    vi.spyOn(protocol, 'refreshNousGrant').mockResolvedValue(rotated)
    const memory = memoryStore(grant({ expires: Date.now() - 1000 }))
    const env = vi.fn(async () => 'synthetic-ambient')
    const models = createModels({ credentials: memory.store, authContext: { env, fileExists: vi.fn(async () => false) } })
    models.setProvider(nousProvider([], approvedClientId))
    await expect(models.getAuth('nous')).rejects.toThrow('OAuth auth derivation failed')
    expect(memory.read()).toEqual(rotated)
    expect(env).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { configuredClientId: undefined, expired: false }, { configuredClientId: undefined, expired: true },
    { configuredClientId: 'other-client', expired: false }, { configuredClientId: 'other-client', expired: true },
    { configuredClientId: ' ', expired: false }, { configuredClientId: ' ', expired: true },
  ])('requires the currently configured public client identity before refresh or bearer derivation (%j)', async ({ configuredClientId, expired }) => {
    const original = grant({ expires: expired ? Date.now() - 1000 : Date.now() + 3600000 })
    const refresh = vi.spyOn(protocol, 'refreshNousGrant').mockResolvedValue(grant({ access: 'rotated', refresh: 'rotated' }))
    const memory = memoryStore(original)
    const env = vi.fn(async () => 'synthetic-ambient')
    const models = createModels({ credentials: memory.store, authContext: { env, fileExists: vi.fn(async () => false) } })
    models.setProvider(nousProvider([], configuredClientId))
    await expect(models.getAuth('nous')).rejects.toThrow('public Nous client ID')
    expect(refresh).not.toHaveBeenCalled()
    expect(memory.read()).toEqual(original)
    expect(env).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('honors the validated stored inference endpoint during Models dispatch', async () => {
    const stored = grant({ inferenceBaseURL: 'https://welcome-api.nousresearch.com/v1' })
    const memory = memoryStore(stored)
    const models = createModels({
      credentials: memory.store, authContext: { env: vi.fn(async () => undefined), fileExists: vi.fn(async () => false) },
    })
    const provider = nousProvider([optional], approvedClientId)
    models.setProvider({ ...provider, getModels: () => [model] })
    const capture = captureFetch()
    const result = await models.stream(model, { messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] }, { fetch: capture.fetch }).result()
    expect(result.stopReason).toBe('stop')
    expect(capture.requests[0]!.url).toBe(`${stored.inferenceBaseURL}/chat/completions`)
    expect(capture.requests[0]!.headers.get('authorization')).toBe(`Bearer ${stored.access}`)
  })
})
