import { afterEach, expect, it, vi } from 'vitest'
import type { Credential, CredentialStore, ProviderStreams } from '@earendil-works/pi-ai'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn((..._args: Parameters<ProviderStreams['streamSimple']>) => { throw new Error('observed SDK boundary') }))
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { catalogProvider, catalogProviderIds, catalogModels } from '../src/catalog.ts'

afterEach(() => streamSimple.mockClear())
const profile: PiAiProviderProfile = {
  models: [{ id: 'account/model', name: 'Account model', contextWindow: 32768, maxTokens: 2048,
    reasoningEfforts: { off: 'none', low: 'low', high: 'high' },
    compat: { thinkingFormat: 'openrouter' } }],
}
const credential: Credential = {
  type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000,
  clientId: 'approved-test-client', scope: 'inference:invoke', inferenceBaseURL: 'https://inference-api.nousresearch.com/v1',
}
function adapter(source: PiAiProviderProfile): PiAiAdapter {
  let stored = credential
  const credentials: CredentialStore = {
    read: async () => stored,
    list: async () => [{ providerId: 'nous', type: 'oauth' }],
    modify: async (_id, fn) => { stored = await fn(stored) ?? stored; return stored },
    delete: async () => {},
  }
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ nous: source }, 'strict', 'approved-test-client'), resolveApiKey: async () => undefined,
    auth: { credentials, authContext: { env: async () => undefined, fileExists: async () => false } },
  })
}
async function request(source: PiAiProviderProfile, reasoningEffort?: 'off' | 'low') {
  const chunks = []
  for await (const chunk of adapter(source).stream({ provider: 'nous', model: 'account/model', messages: [],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }) })) chunks.push(chunk)
  return chunks
}
it('registers a native OAuth route whose model availability comes from the account', () => {
  expect(catalogProviderIds()).toContain('nous')
  expect(catalogProvider('nous')?.auth.apiKey).toBeUndefined()
  expect(catalogProvider('nous')?.auth.oauth?.isSubscription).toBe(true)
  expect(catalogModels('nous').size).toBe(0)
})
it.each(['', ' approved-test-client ', 'bad\nclient'])('rejects invalid registration metadata before a connection can start (%j)', (clientId) => {
  expect(() => resolveProfiles({}, 'strict', clientId)).toThrow('registered client identity')
})
it('resolves configured account models to the native Chat Completions route without a protocol override', () => {
  const route = resolveProfiles({ nous: profile }).get('nous')!
  expect(route.piProvider?.getModels()[0]).toMatchObject({ provider: 'nous', api: 'openai-completions',
    baseUrl: 'https://inference-api.nousresearch.com/v1', id: 'account/model' })
})
it.each([
  { apiKeyEnv: 'NOUS_KEY' }, { api: 'anthropic-messages' }, { baseURL: 'https://example.test/v1' },
])('rejects alternate auth and transport routes for native Nous (%j)', (overrides) => {
  expect(() => resolveProfiles({ nous: { ...profile, api: 'openai-completions', ...overrides } })).toThrow('native OAuth')
})
it('preserves an explicit off choice across the Harness adapter options boundary', async () => {
  const chunks = await request({ ...profile, api: 'openai-completions' }, 'off')
  expect(streamSimple).toHaveBeenCalledOnce()
  expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ samplingParams: { reasoning: { enabled: false } }, maxRetries: 0 })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { message: 'observed SDK boundary' } } })
})
it('does not turn an unspecified Nous effort into an off choice', async () => {
  await request({ ...profile, api: 'openai-completions' })
  expect(streamSimple.mock.calls[0]?.[2]?.samplingParams).toBeUndefined()
})
it('keeps explicit supported efforts in the native pi-ai option vocabulary', async () => {
  await request({ ...profile, api: 'openai-completions' }, 'low')
  expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ reasoning: 'low' })
})
