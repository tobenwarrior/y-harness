/** xAI subscription device authorization over pi-ai's bundled OAuth flow. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { AuthEvent } from '@earendil-works/pi-ai'
import { credentialStoreFrom, authContextFrom, recordKeyFor } from './auth.ts'
import { catalogModels, catalogProvider } from './catalog.ts'
import { createModels } from './models.ts'
import type { XaiConnectionView, XaiDeviceVerification, XaiModelView } from './xai-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { xaiConnection: XaiConnection }
}

interface SignInAttempt {
  controller: AbortController
  resolve: (verification: XaiDeviceVerification) => void
  reject: (error: Error) => void
  flow?: Promise<void>
  session?: AuthorizationSession
  done: Promise<void>
}

/** Device-code lifetime assumed when the provider omits an expiry. Ten minutes covers xAI's current issuance. */
const FALLBACK_DEVICE_TTL_MS = 10 * 60 * 1_000

/**
 * Own one xAI sign-in attempt through cancellation and durable grant commit.
 * The bundled pi-ai OAuth client identity ships inside the dependency; no
 * deployment configuration selects it.
 */
export class XaiConnection extends TypertRemoteService {
  static inject = ['credentials', 'authorization']
  private attempt: SignInAttempt | undefined
  private error: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'xaiConnection', { namespace: 'xai' })
    ctx.authorization.registerFlow({
      key: recordKeyFor('xai'),
      label: 'xAI',
      methods: [{ id: 'oauth', label: 'Sign in with SuperGrok or X Premium' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) throw new Error('Start xAI authorization in Models settings.')
        attempt.session = session
        attempt.flow = this.authorize(attempt, session)
        return attempt.flow
      },
    })
    ctx.effect(() => async () => { await this.cancel() })
  }

  /**
   * Run the bundled pi-ai xAI device flow, publishing browser instructions
   * through the pending start call.
   * @param attempt - the mutable attempt owning cancellation and verification delivery.
   * @param session - the authorization session carrying signal and commit observation.
   */
  private async authorize(attempt: SignInAttempt, session: AuthorizationSession): Promise<void> {
    const models = createModels({
      credentials: credentialStoreFrom(this.ctx),
      authContext: authContextFrom(this.ctx),
    })
    const provider = catalogProvider('xai')
    if (provider === undefined) throw new Error('xAI provider is unavailable in this build.')
    models.setProvider(provider)
    let delivered = false
    await models.login('xai', 'oauth', {
      signal: session.signal,
      notify: (event: AuthEvent) => {
        if (event.type === 'device_code' && !delivered) {
          delivered = true
          const url = (event as { verificationUriComplete?: string }).verificationUriComplete
            ?? (event as { verificationUri: string }).verificationUri
          const code = (event as { userCode: string }).userCode
          const ttl = (event as { expiresInSeconds?: number }).expiresInSeconds
          attempt.resolve({
            url,
            code,
            expiresAt: Date.now() + (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0
              ? ttl * 1_000
              : FALLBACK_DEVICE_TTL_MS),
          })
        }
      },
      prompt: () => Promise.reject(new Error('Complete xAI sign-in in the system browser.')),
    })
  }

  /**
   * Read local connection metadata without redeeming a refresh token.
   * @returns connection and attempt state without credentials.
   */
  @Remote
  async getState(): Promise<XaiConnectionView> {
    const stored = await credentialStoreFrom(this.ctx).read('xai')
    let connected = false
    let expiresAt: number | undefined
    if (stored !== undefined && stored.type === 'oauth') {
      connected = typeof stored.access === 'string' && stored.access.length > 0
        && typeof stored.refresh === 'string' && stored.refresh.length > 0
      if (typeof stored.expires === 'number' && Number.isFinite(stored.expires)) expiresAt = stored.expires
    }
    return {
      configured: true,
      connected,
      busy: this.attempt !== undefined,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  /**
   * Begin one device attempt with explicit local-storage consent.
   * @param saveLocally - affirmative consent to the owner-only unencrypted credential file.
   * @returns browser instructions; the grant commits asynchronously before busy becomes false.
   */
  @Remote
  async start(saveLocally: boolean): Promise<XaiDeviceVerification> {
    if (!saveLocally) throw new Error('Choose local credential storage before signing in.')
    if (this.attempt !== undefined) throw new Error('An xAI sign-in is already in progress.')
    this.error = undefined
    const verification = Promise.withResolvers<XaiDeviceVerification>()
    const attempt: SignInAttempt = { controller: new AbortController(), resolve: verification.resolve,
      reject: verification.reject, done: Promise.resolve() }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: recordKeyFor('xai'), method: 'oauth', signal: attempt.controller.signal,
      interaction: { notify() {}, prompt() { return Promise.reject(new Error('Complete xAI sign-in in the system browser.')) } },
    }).then(async (outcome) => {
      await attempt.flow
      if (outcome.status === 'cancelled') throw new Error('Cancelled')
    }).catch(async () => {
      await attempt.flow?.catch(() => {})
      this.error = (attempt.session?.signal ?? attempt.controller.signal).aborted
        ? 'xAI sign-in cancelled.'
        : 'xAI sign-in could not be completed. Existing credentials were kept; try again.'
      attempt.reject(new Error(this.error))
    }).finally(() => { if (this.attempt === attempt) this.attempt = undefined })
    return verification.promise
  }

  /**
   * Cancel before commit admission; an admitted save completes before cancellation returns.
   * @returns after polling and durable credential work have settled.
   */
  @Remote
  async cancel(): Promise<void> {
    const attempt = this.attempt
    attempt?.controller.abort()
    await attempt?.done
  }

  /**
   * Read the installed xAI catalog for the Models card. No network call:
   * the catalog ships with the build and grok-4.7 is among it.
   * @returns catalog models; failures expose a sanitized retry or sign-in message.
   */
  @Remote
  async models(): Promise<XaiModelView[]> {
    if (this.attempt !== undefined) throw new Error('Finish or cancel xAI sign-in before loading models.')
    try {
      const stored = await credentialStoreFrom(this.ctx).read('xai')
      if (stored === undefined || stored.type !== 'oauth') throw new Error('Sign in first')
      const views: XaiModelView[] = [...catalogModels('xai').values()].flatMap((model) => {
        const efforts = model.thinkingLevelMap === undefined ? undefined : Object.fromEntries(
          Object.entries(model.thinkingLevelMap).flatMap(([level, wire]) =>
            typeof wire === 'string' ? [[level, wire] as const] : []),
        ) as NonNullable<XaiModelView['reasoningEfforts']>
        const view: XaiModelView = {
          id: model.id,
          name: model.name,
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
          ...(Array.isArray(model.input) ? { inputModalities: [...model.input] as Array<'text' | 'image'> } : {}),
          reasoning: model.reasoning,
          ...(efforts === undefined || Object.keys(efforts).length === 0 ? {} : { reasoningEfforts: efforts }),
        }
        return [view]
      })
      if (views.length === 0) throw new Error('No xAI models are available in this build.')
      this.error = undefined
      return views
    } catch (error) {
      this.error = error instanceof Error && /sign in first/i.test(error.message)
        ? 'Sign in with your SuperGrok or X Premium subscription first.'
        : 'xAI models could not be loaded. Existing credentials were kept; try again later.'
      throw new Error(this.error)
    }
  }

  /**
   * Delete this app's local grant while no sign-in is running; remote revocation is user-owned.
   * @returns after the local credential deletion completes.
   */
  @Remote
  async disconnect(): Promise<void> {
    if (this.attempt !== undefined) throw new Error('Finish or cancel xAI sign-in before disconnecting.')
    await credentialStoreFrom(this.ctx).delete('xai')
    this.error = undefined
  }
}
