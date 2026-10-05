/** ChatGPT plan requests use public Responses with the documented preview restrictions. */
import type { Provider, SimpleStreamOptions, StreamOptions } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { refreshGrant } from './chatgpt-protocol.ts'
import type { PiAiModelProfile } from './catalog.ts'
import type { ChatGPTGrant } from './chatgpt-protocol.ts'

/** Fields forbidden by the public ChatGPT-plan HTTP preview. */
const UNSUPPORTED_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation',
  'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
] as const

/** Convert the SDK payload after its ordinary Responses projection, before network I/O. */
function subscriptionOptions<T extends StreamOptions | SimpleStreamOptions>(options: T | undefined, profile: PiAiModelProfile | undefined): T & Pick<StreamOptions, 'onPayload'> {
  return {
    ...options,
    async onPayload(payload, model) {
      const customized = await options?.onPayload?.(payload, model)
      const result = customized ?? payload
      if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('ChatGPT requires a Responses request object.')
      const body: Record<string, unknown> = Object.fromEntries(
        Object.entries(result).filter(([key]) => !UNSUPPORTED_FIELDS.some(field => field === key)),
      )
      const tier = profile?.serviceTier ?? body.service_tier
      if (tier !== undefined) {
        if (tier !== 'default' && !profile?.serviceTiers?.some(candidate => candidate.id === tier)) throw new Error('This processing tier is not advertised for the selected ChatGPT model.')
        body.service_tier = tier
      }
      body.store = false
      body.stream = true
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const tools = body.tools as Array<Record<string, unknown>>
        if (tools.some(tool => tool.type !== 'function' && tool.type !== 'custom')) {
          throw new Error('ChatGPT plan usage supports local function/custom tools; this request declares an unsupported hosted tool.')
        }
        body.tools = [{ type: 'namespace', name: 'functions', tools }]
      }
      if (Array.isArray(body.input)) {
        body.input = (body.input as Array<Record<string, unknown>>).map((item) => {
          if (item.role === 'system') return { ...item, role: 'developer' }
          if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.namespace === undefined) {
            return { ...item, namespace: 'functions' }
          }
          return item
        })
      }
      return body
    },
  } as T & Pick<StreamOptions, 'onPayload'>
}

/** Subscription provider. Models are discovered for the account and saved through settings. */
export function chatGPTProvider(profiles: readonly PiAiModelProfile[] = []): Provider {
  const api = openAIResponsesApi()
  return {
    id: 'chatgpt', name: 'ChatGPT', baseUrl: 'https://api.openai.com/v1', getModels: () => [],
    auth: { oauth: {
      name: 'ChatGPT subscription', isSubscription: true, loginLabel: 'Continue with ChatGPT',
      login() { return Promise.reject(new Error('Use the ChatGPT connection card in Models settings to choose an account and storage.')) },
      refresh: (credential, signal) => refreshGrant(credential as ChatGPTGrant, signal),
      toAuth(credential) { return Promise.resolve({ apiKey: credential.access }) },
    } },
    stream: (model, context, options) => api.stream(model, context,
      subscriptionOptions(options, profiles.find(profile => profile.id === model.id))),
    streamSimple: (model, context, options) => api.streamSimple(model, context,
      subscriptionOptions(options, profiles.find(profile => profile.id === model.id))),
  }
}
