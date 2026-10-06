/** Native Nous device authorization with an explicit public client choice. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialStoreFrom, authContextFrom, recordKeyFor } from './auth.ts'
import { createModels } from './models.ts'
import { nousProvider } from './nous-provider.ts'
import {
  startNousDeviceAuthorization, completeNousDeviceAuthorization, readNousModels, validateNousGrant, NousProtocolError,
} from './nous-protocol.ts'
import type { NousConnectionView, NousDeviceVerification, NousModelView } from './nous-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { nousConnection: NousConnection }
}

/** Public client metadata is configuration; no Hermes credential is imported. */
export interface NousConnectionOptions {
  clientId?: string | (() => string | undefined)
}

interface SignInAttempt {
  clientId: string
  controller: AbortController
  resolve(verification: NousDeviceVerification): void
  reject(error: Error): void
  flow?: Promise<void>
  session?: AuthorizationSession
  done: Promise<void>
}

function catalogFailure(error: unknown): string {
  let cause = error
  for (let depth = 0; depth < 3 && cause instanceof Error; depth++) {
    if (cause instanceof NousProtocolError && cause.reauthenticate) return 'Nous authorization expired or was revoked. Sign in again in Models settings.'
    cause = cause.cause
  }
  return 'Nous model catalog could not be loaded. Existing credentials were kept; try again later.'
}

/** Own one sign-in attempt through cancellation and durable grant commit. */
export class NousConnection extends TypertRemoteService {
  static inject = ['credentials', 'authorization']
  private readonly configuredClientId: NousConnectionOptions['clientId']
  private get clientId(): string | undefined {
    return typeof this.configuredClientId === 'function' ? this.configuredClientId() : this.configuredClientId
  }
  private attempt: SignInAttempt | undefined
  private error: string | undefined

  constructor(ctx: Context, options: NousConnectionOptions = {}) {
    super(ctx, 'nousConnection', { namespace: 'nous' })
    this.configuredClientId = options.clientId
    if (this.clientId !== undefined && (this.clientId.length === 0 || this.clientId.trim() !== this.clientId
      || /[\u0000-\u001f\u007f]/u.test(this.clientId))) {
      throw new Error('Nous requires a nonempty public client identity without surrounding whitespace or control characters.')
    }
    ctx.authorization.registerFlow({
      key: recordKeyFor('nous'), label: 'Nous Portal', methods: [{ id: 'oauth', label: 'Continue with Nous Portal' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) throw new Error('Start Nous authorization in Models settings.')
        attempt.session = session
        attempt.flow = this.authorize(attempt, session)
        return attempt.flow
      },
    })
    ctx.effect(() => async () => { await this.cancel() })
  }

  /**
   * Reject changing public client identity while a device attempt is active.
   * @param nextClientId - the public client id a settings write wants to adopt.
   * @throws when a pending sign-in is still bound to a different client id.
   */
  assertClientChange(nextClientId: string | undefined): void {
    if (this.attempt !== undefined && nextClientId !== this.attempt.clientId) {
      throw new Error('Finish or cancel Nous sign-in before changing its public client ID.')
    }
  }

  private async authorize(attempt: SignInAttempt, session: AuthorizationSession): Promise<void> {
    const clientId = attempt.clientId
    const device = await startNousDeviceAuthorization(clientId, session.signal)
    session.signal.throwIfAborted()
    attempt.resolve(device.verification)
    const grant = await completeNousDeviceAuthorization(clientId, device, session.signal)
    session.signal.throwIfAborted()
    // The authorization seam admits one durable save; later cancellation waits
    // for it rather than reporting cancellation after the grant was written.
    if (this.clientId !== clientId) throw new Error('Nous public client changed during sign-in; try again.')
    await session.commit({ kind: 'grant', payload: grant })
  }

  /**
   * Read local connection metadata without redeeming a refresh token.
   * @returns connection and attempt state without credentials or device polling tokens.
   */
  @Remote
  async getState(): Promise<NousConnectionView> {
    const stored = await credentialStoreFrom(this.ctx).read('nous')
    let connected = false
    let expiresAt: number | undefined
    if (stored !== undefined) {
      try {
        const grant = validateNousGrant(stored)
        connected = this.clientId !== undefined && grant.clientId === this.clientId
        expiresAt = grant.expires
      } catch {
        // The credential plane is durable input; an invalid record requires a new login.
        connected = false
      }
    }
    return { configured: this.clientId !== undefined, connected, busy: this.attempt !== undefined,
      ...(connected && expiresAt !== undefined ? { expiresAt } : {}),
      ...(this.error === undefined ? {} : { error: this.error }) }
  }

  /**
   * Begin one device attempt with explicit local-storage consent and a chosen public client.
   * @param saveLocally - affirmative consent to the owner-only unencrypted credential file.
   * @returns browser instructions; the grant commits asynchronously before busy becomes false.
   */
  @Remote
  async start(saveLocally: boolean): Promise<NousDeviceVerification> {
    const clientId = this.clientId
    if (clientId === undefined) throw new Error('Choose a public Nous device-flow client ID before sign-in.')
    if (!saveLocally) throw new Error('Choose local credential storage before signing in.')
    if (this.attempt !== undefined) throw new Error('A Nous sign-in is already in progress.')
    this.error = undefined
    const verification = Promise.withResolvers<NousDeviceVerification>()
    const attempt: SignInAttempt = { clientId, controller: new AbortController(), resolve: verification.resolve,
      reject: verification.reject, done: Promise.resolve() }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: recordKeyFor('nous'), method: 'oauth', signal: attempt.controller.signal,
      interaction: { notify() {}, prompt() { return Promise.reject(new Error('Complete Nous sign-in in the system browser.')) } },
    }).then(async (outcome) => {
      await attempt.flow
      if (outcome.status === 'cancelled') throw new Error('Cancelled')
    }).catch(async () => {
      // The authorization seam may settle cancellation before the device poll finishes.
      await attempt.flow?.catch(() => {})
      this.error = (attempt.session?.signal ?? attempt.controller.signal).aborted
        ? 'Nous sign-in cancelled.'
        : 'Nous sign-in could not be completed. Existing credentials were kept; try again.'
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
   * Resolve registered OAuth under the credential-store lock and read the account catalog.
   * @returns advertised models; failures expose a sanitized retry or sign-in message.
   */
  @Remote
  async models(): Promise<NousModelView[]> {
    if (this.clientId === undefined) throw new Error('Choose a public Nous device-flow client ID before sign-in.')
    if (this.attempt !== undefined) throw new Error('Finish or cancel Nous sign-in before loading models.')
    try {
      const credentials = credentialStoreFrom(this.ctx)
      const stored = await credentials.read('nous')
      if (stored === undefined || validateNousGrant(stored).clientId !== this.clientId) throw new Error('Sign in first')
      const models = createModels({ credentials, authContext: authContextFrom(this.ctx) })
      models.setProvider(nousProvider([], this.clientId))
      const signal = AbortSignal.timeout(20_000)
      const resolved = await models.getAuth('nous', { signal })
      const auth = resolved?.auth
      if (auth?.apiKey === undefined || auth.baseUrl === undefined) throw new Error('Sign in first')
      const catalog = await readNousModels(auth.apiKey, auth.baseUrl, signal)
      this.error = undefined
      return catalog
    } catch (error) {
      this.error = catalogFailure(error)
      throw new Error(this.error)
    }
  }

  /**
   * Delete this app's local grant while no sign-in is running; Portal revocation is user-owned.
   * @returns after the local credential deletion completes.
   */
  @Remote
  async disconnect(): Promise<void> {
    if (this.attempt !== undefined) throw new Error('Finish or cancel Nous sign-in before disconnecting.')
    await credentialStoreFrom(this.ctx).delete('nous')
    this.error = undefined
  }
}
