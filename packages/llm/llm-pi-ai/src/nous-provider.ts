/** Native Nous subscription requests use the Portal's OpenAI-compatible inference API. */
import type { Model, OAuthCredential, Provider, ProviderHeaders, SimpleStreamOptions, StreamOptions } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { refreshNousGrant, validateNousGrant } from './nous-protocol.ts'
import type { NousModelView } from './nous-types.ts'

/** Routing controls and product tags belong to their owning gateway/client. */
const ROUTING_FIELDS = new Set(['provider', 'providerOptions', 'route', 'models', 'transforms', 'plugins', 'tags'])
/** Nous accepts only the advertised nested effort control below. */
const REASONING_FIELDS = new Set([
  'reasoning', 'reasoning_effort', 'thinking', 'enable_thinking',
  'thinking_budget', 'thinking_token_budget', 'thinking_budget_tokens', 'chat_template_args',
])
const OVERRIDE_HEADERS = new Set(['authorization', 'http-referer', 'x-title'])
type NousOptions = StreamOptions & { reasoning?: string; reasoningEffort?: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Preserve the resolved OAuth bearer and remove stale OpenRouter attribution. */
function inferenceHeaders(headers: ProviderHeaders | undefined): ProviderHeaders | undefined {
  return headers === undefined ? undefined : Object.fromEntries(
    Object.entries(headers).filter(([name]) => !OVERRIDE_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('x-openrouter-')),
  )
}

/** Send an effort only when the account-visible catalog explicitly advertises it. */
function reasoningControl(
  body: Record<string, unknown>, options: NousOptions | undefined, profile: NousModelView | undefined,
  customized: { reasoning: boolean; effort: boolean },
): { effort: string } | { enabled: false } | undefined {
  if (!profile?.reasoning || profile.reasoningEfforts === undefined) return undefined
  const efforts = profile.reasoningEfforts
  const requested = options?.reasoning ?? options?.reasoningEffort
  const mapping = efforts as Record<string, string | undefined>
  if (requested !== undefined && requested !== 'off' && mapping[requested] === undefined) {
    throw new Error('This reasoning effort is not advertised for the selected Nous model.')
  }
  const control = isObject(body.reasoning) ? body.reasoning : undefined
  const nestedEffort = typeof control?.effort === 'string' ? control.effort : undefined
  const topLevelEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined
  if ((customized.reasoning || customized.effort) && nestedEffort === undefined
    && topLevelEffort === undefined && control?.enabled !== false) return undefined
  const explicitNested = customized.reasoning || options?.samplingParams?.reasoning !== undefined
  const explicitTopLevel = customized.effort || options?.samplingParams?.reasoning_effort !== undefined
  const effort = explicitNested ? nestedEffort ?? topLevelEffort
    : explicitTopLevel ? topLevelEffort
      : requested === undefined ? nestedEffort ?? topLevelEffort : mapping[requested] ?? requested
  const disabled = (explicitNested && control?.enabled === false) || effort === 'none' || effort === 'off' || (effort !== undefined && effort === efforts.off)
  const explicit = requested !== undefined || explicitNested || explicitTopLevel
  if (disabled || (effort === undefined && requested === 'off')) {
    // pi-ai's OpenRouter format defaults to "none". Nous owns its default;
    // only an explicit, advertised optional off choice may disable reasoning.
    return explicit && profile.reasoningMandatory === false && efforts.off !== undefined
      ? { enabled: false }
      : undefined
  }
  const selected = effort ?? (requested === 'off' ? undefined : requested)
  if (selected === undefined) return undefined
  const wire = mapping[selected] ?? Object.entries(efforts).find(([level, value]) => level !== 'off' && value === selected)?.[1]
  if (wire === undefined) throw new Error('This reasoning effort is not advertised for the selected Nous model.')
  return { effort: wire }
}

/** Compose customization first, then enforce Nous's metadata-backed payload. */
function inferenceOptions<T extends StreamOptions | SimpleStreamOptions>(options: T | undefined, profile: NousModelView | undefined): T & Pick<StreamOptions, 'onPayload'> {
  return {
    ...options,
    ...options?.headers === undefined ? {} : { headers: inferenceHeaders(options.headers) },
    async onPayload(payload, model) {
      const originalReasoning = isObject(payload) ? payload.reasoning : undefined
      const originalReasoningEffort = isObject(payload) ? payload.reasoning_effort : undefined
      const originalEffort = isObject(originalReasoning) ? originalReasoning.effort : undefined
      const originalEnabled = isObject(originalReasoning) ? originalReasoning.enabled : undefined
      const customized = await options?.onPayload?.(payload, model)
      const result = customized === undefined ? payload : customized
      if (!isObject(result)) throw new Error('Nous requires a Chat Completions request object.')
      const currentReasoning = isObject(result.reasoning) ? result.reasoning : undefined
      const changedReasoning = currentReasoning?.effort !== originalEffort || currentReasoning?.enabled !== originalEnabled
      const body: Record<string, unknown> = Object.fromEntries(
        Object.entries(result).filter(([field]) => !ROUTING_FIELDS.has(field) && !REASONING_FIELDS.has(field)),
      )
      if (isObject(body.chat_template_kwargs)) {
        const kwargs = Object.fromEntries(Object.entries(body.chat_template_kwargs).filter(([field]) =>
          !REASONING_FIELDS.has(field) && field !== 'preserve_thinking'))
        if (Object.keys(kwargs).length === 0) delete body.chat_template_kwargs
        else body.chat_template_kwargs = kwargs
      }
      const reasoning = reasoningControl(result, options, profile,
        { reasoning: changedReasoning, effort: result.reasoning_effort !== originalReasoningEffort })
      if (reasoning !== undefined) body.reasoning = reasoning
      return body
    },
  } as T & Pick<StreamOptions, 'onPayload'>
}

function inferenceModel<T extends Model<string>>(model: T): T {
  return model.headers === undefined ? model : { ...model, headers: inferenceHeaders(model.headers) }
}

/**
 * Build native Nous streams with OAuth bound to the deployment's approved client identity.
 * @param profiles - account-advertised reasoning metadata for configured models.
 * @param expectedClientId - approved registration; absence disables request authentication.
 * @returns an OAuth-only provider whose account models are owned by Models settings.
 */
export function nousProvider(profiles: readonly NousModelView[] = [], expectedClientId?: string): Provider {
  const api = openAICompletionsApi()
  const registeredGrant = (credential: OAuthCredential) => {
    const grant = validateNousGrant(credential)
    if (expectedClientId === undefined || expectedClientId.length === 0
      || expectedClientId.trim() !== expectedClientId || grant.clientId !== expectedClientId) {
      throw new Error('Choose a public Nous client ID matching the stored connection. Reconnect through Models settings.')
    }
    return grant
  }
  return {
    id: 'nous', name: 'Nous Portal', baseUrl: 'https://inference-api.nousresearch.com/v1', getModels: () => [],
    auth: { oauth: {
      name: 'Nous Portal subscription', isSubscription: true, loginLabel: 'Continue with Nous Portal',
      login() { return Promise.reject(new Error('Use the Nous connection card in Models settings to connect with this deployment\'s configured client identity.')) },
      async refresh(credential, signal) { return refreshNousGrant(registeredGrant(credential), signal) },
      toAuth(credential) {
        return Promise.resolve().then(() => {
          const grant = registeredGrant(credential)
          return { apiKey: grant.access, baseUrl: grant.inferenceBaseURL }
        })
      },
    } },
    stream: (model, context, options) => api.stream(inferenceModel(model), context,
      inferenceOptions(options, profiles.find(profile => profile.id === model.id))),
    streamSimple: (model, context, options) => api.streamSimple(inferenceModel(model), context,
      inferenceOptions(options, profiles.find(profile => profile.id === model.id))),
  }
}
