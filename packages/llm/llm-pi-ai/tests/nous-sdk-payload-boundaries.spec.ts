import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Model, ProviderStreams, StreamOptions } from '@earendil-works/pi-ai'
import { nousProvider } from '../src/nous-provider.ts'
import type { NousModelView } from '../src/nous-types.ts'

const sdk = vi.hoisted(() => ({
  stream: vi.fn<ProviderStreams['stream']>(() => { throw new Error('Synthetic SDK admission') }),
  simple: vi.fn<ProviderStreams['streamSimple']>(() => { throw new Error('Synthetic SDK admission') }),
}))
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: sdk.stream, streamSimple: sdk.simple }),
}))
afterEach(() => { sdk.stream.mockClear(); sdk.simple.mockClear() })

const model: Model<'openai-completions'> = {
  id: 'fixture-model', name: 'Fixture model', provider: 'nous', api: 'openai-completions',
  baseUrl: 'https://inference-api.nousresearch.com/v1', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512,
}
const profile: NousModelView = {
  id: model.id, name: model.name, reasoning: true, reasoningMandatory: false,
  reasoningEfforts: { off: 'none', high: 'high' },
}
function admitted(options?: StreamOptions & { reasoning?: string }, metadata = profile) {
  const provider = nousProvider([metadata], 'fixture-client')
  expect(() => provider.stream(model, normalizeContext({ messages: [] }), options)).toThrow('Synthetic SDK admission')
  const forwarded = sdk.stream.mock.calls.at(-1)?.[2]
  if (forwarded?.onPayload === undefined) throw new Error('Missing payload admission callback')
  return forwarded
}

describe('Nous SDK payload admission', () => {
  it.each([undefined, null, [], 17, 'unexpected'])('rejects a non-object SDK payload before inference: %j', async (payload) => {
    const options = admitted()
    await expect(options.onPayload?.(payload, model)).rejects.toThrow('request object')
  })

  it('allows a caller to replace an unexpected SDK payload with a valid native request', async () => {
    const options = admitted({ onPayload: () => ({ model: model.id, messages: [], temperature: 0.2 }) })
    expect(await options.onPayload?.(null, model)).toEqual({ model: model.id, messages: [], temperature: 0.2 })
  })

  it('uses a top-level advertised effort when an explicit nested object leaves effort unset', async () => {
    const options = admitted({ samplingParams: { reasoning: {}, reasoning_effort: 'high' } })
    expect(await options.onPayload?.({ model: model.id, reasoning: {}, reasoning_effort: 'high' }, model))
      .toEqual({ model: model.id, reasoning: { effort: 'high' } })
  })

  it('does not invent an effort when a caller supplies a nested object without one', async () => {
    const options = admitted({ samplingParams: { reasoning: {} } })
    expect(await options.onPayload?.({ model: model.id, reasoning: {} }, model)).toEqual({ model: model.id })
  })

  it('honors an explicit off selection when the SDK has no nested effort default', async () => {
    const options = admitted({ reasoning: 'off', samplingParams: { reasoning: 'unrecognized-sdk-control' } })
    expect(await options.onPayload?.({ model: model.id, reasoning: 'unrecognized-sdk-control' }, model))
      .toEqual({ model: model.id, reasoning: { enabled: false } })
  })

  it('keeps an unadvertised off choice out of the native request', async () => {
    const options = admitted({ reasoning: 'off' }, { ...profile, reasoningEfforts: { high: 'high' } })
    expect(await options.onPayload?.({ model: model.id }, model)).toEqual({ model: model.id })
  })

  it('preserves supported template fields after removing foreign thinking controls', async () => {
    const options = admitted()
    expect(await options.onPayload?.({ model: model.id,
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true, temperature: 0.5 },
    }, model)).toEqual({ model: model.id, chat_template_kwargs: { temperature: 0.5 } })
  })
})
