/** Host-only OpenAI avatar generation backed by the existing credential and attachment seams. */

import { Context } from '@yharness/cordis'
import { brandString } from '@yharness/brand'
import type { CredentialRef } from '@yharness/credentials/types'
import type {} from '@yharness/settings'
import z from '@yharness/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@yharness/typert-protocol'
import type {
  AvatarGenerationRequest,
  AvatarGenerationCommitRequest,
  AvatarGenerationCommitValue,
  AvatarGenerationStatus,
  AvatarGenerationUnavailableReason,
  AvatarGenerationValue,
} from './types.ts'

export type * from './types.ts'

declare module '@yharness/cordis' {
  interface Context {
    /** Host-only image generation for Bot avatar previews. */
    avatarGeneration: AvatarGenerationService
  }
}

/** Deployment configuration for the OpenAI Images API adapter. */
export interface Config {
  /** Existing credential-reference name used by an explicit OpenAI route. */
  readonly credentialRef?: string
  /** OpenAI-compatible Images API base URL. */
  readonly baseURL?: string
  /** Image model accepted by the configured endpoint. */
  readonly model?: string
  /** Upper bound for one provider request. */
  readonly timeoutMs?: number
  /** Maximum user description length sent to the provider. */
  readonly maxDescriptionChars?: number
  /** Maximum decoded provider image bytes admitted before attachment validation. */
  readonly maxImageBytes?: number
  /** Maximum encoded HTTP response bytes read from the provider. */
  readonly maxResponseBytes?: number
}

/** Host dependencies replaceable by focused tests and compatible gateways. */
export interface AvatarGenerationInternals {
  /** Fetch implementation for the OpenAI Images API. */
  readonly fetch?: typeof fetch
}

interface ResolvedConfig {
  readonly credentialRef?: string
  readonly baseURL: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxDescriptionChars: number
  readonly maxImageBytes: number
  readonly maxResponseBytes: number
}

interface CredentialDiscovery {
  readonly provider: 'openai' | null
  readonly ref?: CredentialRef
  readonly reason?: AvatarGenerationUnavailableReason
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function member(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined
}

function stringMember(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = member(value, key)
  return typeof candidate === 'string' ? candidate : undefined
}

function textLength(value: string): number {
  return [...value].length
}

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function isCredentialRefName(value: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(value)
}

function credentialRef(value: string): CredentialRef {
  return brandString<CredentialRef>(value)
}

function endpointFor(baseURL: string): string {
  return new URL('images/generations', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString()
}

function promptFor(description: string): string {
  return [
    'Create one centered avatar icon for a software assistant.',
    'Use a polished, friendly, high-contrast illustration with a clean silhouette and a transparent background.',
    'Do not include text, letters, logos, watermarks, borders, or a scene around the subject.',
    `Avatar concept: ${description}`,
  ].join(' ')
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new RemoteError('avatar-generation/response-invalid', 'OpenAI returned invalid avatar data.', {})
  }
  if (Math.ceil(value.length * 3 / 4) > maxBytes) {
    throw new RemoteError('avatar-generation/response-invalid', 'OpenAI returned an avatar that is too large.', {})
  }
  const decoded = Uint8Array.from(Buffer.from(value, 'base64'))
  if (decoded.byteLength === 0) {
    throw new RemoteError('avatar-generation/response-invalid', 'OpenAI returned empty avatar data.', {})
  }
  return decoded
}

function decodeCanonicalBase64(value: string, maxBytes: number): Uint8Array {
  const decoded = decodeBase64(value, maxBytes)
  if (Buffer.from(decoded).toString('base64') !== value) {
    throw new RemoteError('avatar-generation/response-invalid', 'The avatar data is not canonical base64.', {})
  }
  return decoded
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/** Read one response body chunk while allowing the request timeout to abort a pending read. */
function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      void reader.cancel(signal.reason).catch((error: unknown) => {
        // The request is already aborting; the stream's cleanup result is not actionable.
        void error
      })
      reject(signal.reason)
    }
    const cleanup = () => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (value) => { cleanup(); resolve(value) },
      (error) => { cleanup(); reject(error) },
    )
  })
}

/** Decode a bounded JSON response without buffering an untrusted provider body. */
async function readResponsePayload(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  // Test doubles and a body-less 204 response do not expose a reader. Real
  // successful Images API responses have a body, so the bounded path covers
  // all provider data that can contain an image payload.
  if (response.body === null || response.body === undefined) return response.json()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await readChunk(reader, signal)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        throw new RemoteError('avatar-generation/response-invalid', 'OpenAI returned an avatar response that is too large.', {})
      }
      chunks.push(chunk.value)
    }
  } finally {
    try {
      await reader.cancel()
    } catch (error: unknown) {
      // The provider stream is already closed or aborted; cleanup failure cannot change the response decision.
      void error
    }
    reader.releaseLock()
  }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(body))
    return payload
  } catch (error: unknown) {
    throw new RemoteError('avatar-generation/response-invalid', 'OpenAI returned an unreadable avatar response.', {}, { cause: error })
  }
}

/** Host service that discovers the configured OpenAI credential per operation. */
export default class AvatarGenerationService extends TypertRemoteService {
  static Config: z<Config, ResolvedConfig> = z.object({
    credentialRef: z.string().min(1),
    baseURL: z.string().min(1).default('https://api.openai.com/v1'),
    model: z.string().min(1).default('gpt-image-2.5-flare'),
    timeoutMs: z.natural().min(1_000).default(120_000),
    maxDescriptionChars: z.natural().min(1).default(800),
    maxImageBytes: z.natural().min(1).default(8 * 1024 * 1024),
    maxResponseBytes: z.natural().min(1).default(16 * 1024 * 1024),
  })

  private readonly config: ResolvedConfig
  private readonly fetchImpl: typeof fetch

  /**
   * @param ctx - Host context with optional credential settings and attachment services.
   * @param config - OpenAI endpoint and request policy.
   * @param internals - Injectable HTTP implementation for tests.
   */
  constructor(ctx: Context, config: Config, internals: AvatarGenerationInternals = {}) {
    super(ctx, 'avatarGeneration', { namespace: 'avatarGeneration' })
    this.config = AvatarGenerationService.Config(config)
    this.fetchImpl = internals.fetch ?? fetch
  }

  /**
   * Read current capability state without resolving or returning a secret.
   * @returns whether the existing OpenAI provider can generate an avatar now.
   */
  @Remote
  async status(): Promise<AvatarGenerationStatus> {
    const discovery = this.discoverCredential()
    if (discovery.reason !== undefined) {
      return { available: false, provider: discovery.provider, model: this.config.model, reason: discovery.reason }
    }
    if (discovery.ref === undefined) {
      return {
        available: false,
        provider: discovery.provider,
        model: this.config.model,
        reason: 'openai-credential-not-configured',
      }
    }
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      return { available: false, provider: 'openai', model: this.config.model, reason: 'credential-store-unavailable' }
    }
    const info = await credentials.describe(discovery.ref)
    if (!info.configured) {
      return { available: false, provider: 'openai', model: this.config.model, reason: 'openai-credential-not-configured' }
    }
    if (this.ctx.get('attachments') === undefined) {
      return { available: false, provider: 'openai', model: this.config.model, reason: 'attachments-unavailable' }
    }
    return { available: true, provider: 'openai', model: this.config.model }
  }

  /**
   * Generate one validated PNG avatar preview through the configured OpenAI route.
   * @param request - bounded natural-language avatar description.
   * @param signal - caller cancellation signal.
   * @returns exact preview bytes for immediate Client display; persistence waits for {@link commit}.
   * @throws {RemoteError} when configuration, provider, response, or attachment admission fails.
   */
  @Remote
  async generate(request: AvatarGenerationRequest, signal: AbortSignal): Promise<AvatarGenerationValue> {
    const description = this.descriptionOf(request)
    const status = await this.status()
    if (!status.available) {
      throw new RemoteError(
        'avatar-generation/unavailable',
        `OpenAI avatar generation is unavailable: ${status.reason}`,
        { reason: status.reason },
      )
    }
    const discovery = this.discoverCredential()
    if (discovery.ref === undefined) {
      throw new RemoteError('avatar-generation/unavailable', 'OpenAI avatar credential is unavailable.', {
        reason: 'openai-credential-not-configured',
      })
    }
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError('avatar-generation/unavailable', 'Credential storage is unavailable.', {
        reason: 'credential-store-unavailable',
      })
    }
    const resolved = await credentials.resolve(discovery.ref)
    if (resolved === undefined) {
      throw new RemoteError('avatar-generation/unavailable', 'OpenAI avatar credential is unavailable.', {
        reason: 'openai-credential-not-configured',
      })
    }
    signal.throwIfAborted()

    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort(new Error('avatar generation timed out')) }, this.config.timeoutMs)
    const requestSignal = AbortSignal.any([signal, controller.signal])
    try {
      let response: Response
      try {
        response = await this.fetchImpl(endpointFor(this.config.baseURL), {
          method: 'POST',
          headers: { Authorization: `Bearer ${resolved.value}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.config.model,
            prompt: promptFor(description),
            n: 1,
            size: '1024x1024',
            background: 'transparent',
            output_format: 'png',
            quality: 'medium',
          }),
          signal: requestSignal,
        })
      } catch (error: unknown) {
        if (signal.aborted) signal.throwIfAborted()
        throw new RemoteError('avatar-generation/network', 'The OpenAI avatar request could not be completed.', {}, { cause: error })
      }

      if (!response.ok) await this.providerError(response)
      let payload: unknown
      try {
        payload = await readResponsePayload(response, requestSignal, this.config.maxResponseBytes)
      } catch (error: unknown) {
        if (signal.aborted) signal.throwIfAborted()
        if (controller.signal.aborted) {
          throw new RemoteError('avatar-generation/network', 'The OpenAI avatar request timed out.', {}, { cause: error })
        }
        if (error instanceof RemoteError) throw error
        throw new RemoteError('avatar-generation/response-invalid', 'OpenAI returned an unreadable avatar response.', {}, { cause: error })
      }
      const entries = isRecord(payload) ? member(payload, 'data') : undefined
      const first = Array.isArray(entries) ? entries[0] : undefined
      const encoded = isRecord(first) ? stringMember(first, 'b64_json') : undefined
      if (encoded === undefined) {
        throw new RemoteError('avatar-generation/response-invalid', 'OpenAI returned no avatar image.', {})
      }
      const data = decodeBase64(encoded, this.config.maxImageBytes)
      const attachments = this.ctx.get('attachments')
      if (attachments === undefined) {
        throw new RemoteError('avatar-generation/attachment', 'The attachment provider is unavailable.', {})
      }
      try {
        await attachments.validateImage({ data, mediaType: 'image/png', name: 'avatar.png' })
        return {
          data: Buffer.from(data).toString('base64'),
          mediaType: 'image/png',
        }
      } catch (error: unknown) {
        throw new RemoteError('avatar-generation/attachment', 'The generated avatar could not be validated.', {}, { cause: error })
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Persist one preview after the user explicitly chooses it.
   * @param request - canonical preview bytes returned by {@link generate}.
   * @returns the durable image reference for Bot assignment.
   * @throws {RemoteError} when the preview is malformed or attachment admission fails.
   */
  @Remote
  async commit(request: AvatarGenerationCommitRequest): Promise<AvatarGenerationCommitValue> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new RemoteError('avatar-generation/attachment', 'The attachment provider is unavailable.', {})
    }
    try {
      const [attachment] = await attachments.saveImages([{
        data: decodeCanonicalBase64(request.data, this.config.maxImageBytes),
        mediaType: request.mediaType,
      }])
      if (attachment === undefined) throw new Error('Attachment admission returned no image reference')
      return { attachment }
    } catch (error: unknown) {
      throw new RemoteError('avatar-generation/attachment', 'The generated avatar could not be stored.', {}, { cause: error })
    }
  }

  private descriptionOf(request: AvatarGenerationRequest): string {
    if (request === null || typeof request !== 'object' || typeof request.description !== 'string') {
      throw new RemoteError('avatar-generation/invalid-request', 'Avatar description is required.', { reason: 'empty-description' })
    }
    const description = request.description.trim()
    if (description.length === 0) {
      throw new RemoteError('avatar-generation/invalid-request', 'Avatar description is required.', { reason: 'empty-description' })
    }
    if (textLength(description) > this.config.maxDescriptionChars) {
      throw new RemoteError('avatar-generation/invalid-request', 'Avatar description is too long.', { reason: 'description-too-long' })
    }
    return description
  }

  private discoverCredential(): CredentialDiscovery {
    const explicit = this.config.credentialRef
    if (explicit !== undefined) {
      return isCredentialRefName(explicit)
        ? { provider: 'openai', ref: credentialRef(explicit) }
        : { provider: 'openai', reason: 'invalid-credential-reference' }
    }
    const settings = this.ctx.get('settings')
    const descriptor = settings?.describe({ redactSecrets: true }).find(candidate => String(candidate.ns) === 'llm-pi-ai')
    if (descriptor === undefined || !isRecord(descriptor.value)) {
      return { provider: null, reason: 'openai-provider-not-configured' }
    }
    const providers = member(descriptor.value, 'providers')
    if (!isRecord(providers)) return { provider: 'openai', reason: 'openai-provider-not-configured' }
    const openai = member(providers, 'openai')
    if (!isRecord(openai)) return { provider: 'openai', reason: 'openai-provider-not-configured' }
    const reference = stringMember(openai, 'apiKeyEnv')
    if (reference === undefined) return { provider: 'openai', reason: 'openai-credential-not-configured' }
    if (!isCredentialRefName(reference)) return { provider: 'openai', reason: 'invalid-credential-reference' }
    return { provider: 'openai', ref: credentialRef(reference) }
  }

  private async providerError(response: Response): Promise<never> {
    try {
      await response.body?.cancel()
    } catch (error: unknown) {
      // Preserve the mapped provider failure when a rejected response body cannot be cancelled.
      void error
    }
    if (response.status === 401 || response.status === 403) {
      throw new RemoteError('avatar-generation/provider-auth', 'OpenAI rejected the configured credential.', { status: response.status })
    }
    if (response.status === 429) {
      const retry = retryAfterSeconds(response)
      throw new RemoteError(
        'avatar-generation/rate-limited',
        'OpenAI is rate limiting avatar generation.',
        { status: response.status, ...(retry === undefined ? {} : { retryAfterSeconds: retry }) },
      )
    }
    throw new RemoteError('avatar-generation/provider', `OpenAI avatar generation failed with HTTP ${String(response.status)}.`, {
      status: response.status,
    })
  }
}
