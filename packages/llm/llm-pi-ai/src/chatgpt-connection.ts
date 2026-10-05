/** Models-settings controller for explicit ChatGPT authorization and account selection. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { CHATGPT_KEY, modifyChatGPTState, readChatGPTState } from './chatgpt-state.ts'
import { startAuthorization, readModels, refreshGrant, revokeGrant } from './chatgpt-protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { chatGPTConnection: ChatGPTConnection }
}

import type { ChatGPTConnectionView, ChatGPTModelView } from './chatgpt-types.ts'

interface SignInAttempt {
  controller: AbortController
  accountId?: string
  resolveUrl(url: string): void
  rejectUrl(error: Error): void
  flow?: Promise<void>
  done: Promise<void>
}

/** Own one user-initiated login through completion and callback-listener cleanup. */
export class ChatGPTConnection extends TypertRemoteService {
  static inject = ['credentials', 'authorization']
  private attempt: SignInAttempt | undefined
  private error: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'chatGPTConnection', { namespace: 'chatGPT' })
    ctx.authorization.registerFlow({
      key: CHATGPT_KEY, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Continue with ChatGPT' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) throw new Error('Choose account and local storage in Models settings before signing in.')
        attempt.flow = this.authorize(attempt, session)
        return attempt.flow
      },
    })
    ctx.effect(() => async () => { const attempt = this.attempt; attempt?.controller.abort(); await attempt?.done })
  }

  private async authorize(attempt: SignInAttempt, session: AuthorizationSession): Promise<void> {
    const ctx = this.ctx
    const state = await modifyChatGPTState(ctx, current => current)
    const previous = state.accounts.find(account => account.id === attempt.accountId)
    if (attempt.accountId !== undefined && previous === undefined) throw new Error('Selected ChatGPT account no longer exists.')
    const pending = await startAuthorization(state.hostId, previous === undefined ? undefined : {
      type: 'oauth', access: '', refresh: '', expires: 0,
      clientId: previous.clientId, subject: previous.subject, email: previous.email,
    }, session.signal)
    attempt.resolveUrl(pending.url)
    const grant = await pending.completion
    session.signal.throwIfAborted()
    await modifyChatGPTState(ctx, (current) => {
      session.signal.throwIfAborted()
      const matched = current.accounts.find(account => account.clientId === grant.clientId && account.subject === grant.subject)
      const id = matched?.id ?? randomUUID()
      current.accounts = [
        ...current.accounts.filter(account => account.id !== id),
        { id, clientId: grant.clientId, subject: grant.subject, email: grant.email, grant },
      ]
      current.activeId = id
      return current
    })
  }

  /** Return account labels and status only; never tokens or authorization URLs. */
  @Remote
  async getState(): Promise<ChatGPTConnectionView> {
    const state = await readChatGPTState(this.ctx)
    return { accounts: state?.accounts.map(account => ({ id: account.id, label: `${account.email} · ${account.clientId.slice(-8)}`, connected: account.grant !== undefined })) ?? [],
      ...(state?.activeId === undefined ? {} : { activeId: state.activeId }), busy: this.attempt !== undefined,
      ...(this.error === undefined ? {} : { error: this.error }) }
  }

  /** Start after explicit local-file consent; return a browser URL containing no tokens. */
  @Remote
  async start(accountId: string | undefined, saveLocally: boolean): Promise<string> {
    if (!saveLocally) throw new Error('Choose local credential storage before signing in.')
    if (this.attempt !== undefined) throw new Error('A ChatGPT sign-in is already in progress.')
    this.error = undefined
    const deferred = Promise.withResolvers<string>()
    const attempt: SignInAttempt = { controller: new AbortController(),
      ...(accountId === undefined ? {} : { accountId }), resolveUrl: deferred.resolve, rejectUrl: deferred.reject, done: Promise.resolve() }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({ key: CHATGPT_KEY, method: 'oauth', signal: attempt.controller.signal,
      interaction: { notify() {}, prompt() { return Promise.reject(new Error('This sign-in requires the system browser.')) } },
    }).then(async (outcome) => {
      await attempt.flow
      if (outcome.status === 'cancelled') throw new Error('Cancelled')
    }).catch(async () => {
      // The authorization seam can settle cancellation before the flow closes its listener.
      await attempt.flow?.catch(() => {})
      this.error = attempt.controller.signal.aborted ? 'ChatGPT sign-in cancelled.' : 'ChatGPT sign-in could not be completed. Existing accounts were kept; try again.'
      attempt.rejectUrl(new Error(this.error))
    }).finally(() => { if (this.attempt === attempt) this.attempt = undefined })
    return deferred.promise
  }

  /** Cancel and wait for callback-listener cleanup before allowing another attempt. */
  @Remote
  async cancel(): Promise<void> { const attempt = this.attempt; attempt?.controller.abort(); await attempt?.done }

  /** Select a saved registration; credentials for other registrations are retained. */
  @Remote
  async select(accountId: string): Promise<ChatGPTConnectionView> {
    if (this.attempt !== undefined) throw new Error('Finish or cancel sign-in before switching accounts.')
    await modifyChatGPTState(this.ctx, (state) => {
      if (!state.accounts.some(account => account.id === accountId && account.grant !== undefined)) throw new Error('Sign in to this ChatGPT account before selecting it.')
      state.activeId = accountId
      return state
    })
    return this.getState()
  }

  /** Fetch the selected account's catalog; token rotation is serialized by the credential store. */
  @Remote
  async models(): Promise<ChatGPTModelView[]> {
    let access: string | undefined
    await modifyChatGPTState(this.ctx, async (state) => {
      const account = state.accounts.find(candidate => candidate.id === state.activeId)
      if (account?.grant === undefined) throw new Error('Continue with ChatGPT before loading models.')
      if (account.grant.expires < Date.now() + 60_000) account.grant = await refreshGrant(account.grant, AbortSignal.timeout(20_000))
      access = account.grant.access
      return state
    })
    if (access === undefined) throw new Error('Continue with ChatGPT before loading models.')
    return readModels(access)
  }

  /** Revoke and clear only this account's tokens; false requires manual disconnection in ChatGPT settings. */
  @Remote
  async disconnect(accountId: string): Promise<boolean> {
    if (this.attempt !== undefined) throw new Error('Finish or cancel sign-in before disconnecting.')
    let revoked = true
    await modifyChatGPTState(this.ctx, async (state) => {
      const account = state.accounts.find(candidate => candidate.id === accountId)
      if (account?.grant !== undefined) { revoked = await revokeGrant(account.grant); delete account.grant }
      if (state.activeId === accountId) delete state.activeId
      return state
    })
    return revoked
  }
}
