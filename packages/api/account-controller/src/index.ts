/** Authenticated Remote operations for account UI consumers. */
import { randomUUID } from 'node:crypto'
import { Context } from '@yharness/cordis'
import { brandString } from '@yharness/brand'
import type { AuthorizationNotice } from '@yharness/authorization'
import { GITHUB_APP_CREDENTIAL_KEY, GITHUB_DEVICE_VERIFICATION_URL } from '@yharness/github-app-auth'
import type GitHubAppAuth from '@yharness/github-app-auth'
import { Remote, TypertRemoteService } from '@yharness/typert-protocol'
import { isRunningAccountTask } from '@yharness/deepseek-account'
import type {} from '@yharness/agent'
import type { AccountBonusBatch, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountUserId } from '@yharness/deepseek-account/types'
import type { AccountView, GitHubAppSignInAttempt, GitHubAppSignInAttemptId, GitHubAppSignInView, SignInAttemptId } from './types.ts'

export type * from './types.ts'

/** The optional Host capability used to persist and refresh the GitHub grant. */
type GitHubAppAuthSurface = Pick<GitHubAppAuth, 'status' | 'disconnect'>

interface GitHubAppAttempt {
  readonly id: GitHubAppSignInAttemptId
  readonly controller: AbortController
  done: Promise<void>
  view: GitHubAppSignInAttempt
}

const GITHUB_APP_METHOD = 'device'

/** Whether a device-flow attempt can still be cancelled. */
function isActiveGitHubAttempt(view: GitHubAppSignInAttempt): boolean {
  return view.phase === 'starting' || view.phase === 'waiting'
}

/** Keep the serialized owner-operation lane open after either operation outcome. */
function settleGitHubAppTransition(): void {}

/** Account commands and reconnect-safe state stream. */
export class AccountController extends TypertRemoteService {
  static inject = ['deepseekAccount', 'agents', 'authorization']
  private currentGitHubAppAttempt: GitHubAppAttempt | undefined
  private githubAppTransition: Promise<void> = Promise.resolve()
  private closed = false

  /** @param ctx - Host with the account provider mounted. */
  constructor(ctx: Context) {
    super(ctx, 'accountController', { namespace: 'account' })
    // Capture the required service before teardown starts. Cordis unloads all
    // effects concurrently, so an awaited cleanup cannot resolve the service
    // through its context after the provider's own disposer has run.
    const authorization = this.ctx.authorization
    ctx.effect(() => async () => {
      this.closed = true
      await this.githubAppTransition
      const attempt = this.currentGitHubAppAttempt
      if (attempt !== undefined && isActiveGitHubAttempt(attempt.view)) {
        attempt.controller.abort()
        authorization.cancel(GITHUB_APP_CREDENTIAL_KEY)
        await attempt.done
      }
    }, 'account: GitHub App sign-in lifetime')
  }

  /**
   * Read the optional GitHub App grant state without returning any credential material.
   * @returns owner-facing device-flow state.
   */
  @Remote
  async getGitHubAppSignIn(): Promise<GitHubAppSignInView> {
    return this.githubAppView()
  }

  /**
   * Start one GitHub App device authorization attempt.
   * @returns the redacted state that the owner UI polls while the browser flow runs.
   */
  @Remote
  async startGitHubAppSignIn(): Promise<GitHubAppSignInView> {
    return this.serialGitHubAppOperation(() => this.startGitHubAppSignInInternal())
  }

  /** Start the flow after the owner-operation queue has admitted it. */
  private async startGitHubAppSignInInternal(): Promise<GitHubAppSignInView> {
    if (this.closed) return this.githubAppView()
    const auth = this.githubAppAuth()
    if (auth === undefined) return { status: 'unavailable', attempt: null }
    const active = this.currentGitHubAppAttempt
    if (active !== undefined && isActiveGitHubAttempt(active.view)) return this.githubAppView()
    if (await this.githubAppStatus(auth) === 'connected') return this.githubAppView()
    const id = brandString<GitHubAppSignInAttemptId>(randomUUID())
    const attempt: GitHubAppAttempt = {
      id,
      controller: new AbortController(),
      done: Promise.resolve(),
      view: { id, phase: 'starting' },
    }
    this.currentGitHubAppAttempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: GITHUB_APP_CREDENTIAL_KEY,
      method: GITHUB_APP_METHOD,
      signal: attempt.controller.signal,
      interaction: { notify: (notice) => { this.githubAppNotice(attempt, notice) }, prompt: () => Promise.reject(new Error('GitHub App device authorization does not use prompts')) },
    }).then((outcome) => {
      this.setGitHubAppTerminal(attempt, outcome.status === 'authorized' ? 'succeeded' : 'cancelled')
    }).catch(() => {
      // The Remote view intentionally has no error field: provider details and
      // token-shaped messages must never cross the owner UI boundary.
      this.setGitHubAppTerminal(attempt, attempt.controller.signal.aborted ? 'cancelled' : 'failed')
    })
    return this.githubAppView()
  }

  /**
   * Cancel one local GitHub App device-flow attempt.
   * @param attemptId - opaque attempt id returned by the start/read methods.
   * @returns settled redacted state.
   */
  @Remote
  async cancelGitHubAppSignIn(attemptId: GitHubAppSignInAttemptId): Promise<GitHubAppSignInView> {
    return this.serialGitHubAppOperation(() => this.cancelGitHubAppSignInInternal(attemptId))
  }

  /** Cancel one flow after the owner-operation queue has admitted it. */
  private async cancelGitHubAppSignInInternal(attemptId: GitHubAppSignInAttemptId): Promise<GitHubAppSignInView> {
    const attempt = this.currentGitHubAppAttempt
    if (attempt?.id !== attemptId || !isActiveGitHubAttempt(attempt.view)) return this.githubAppView()
    await this.cancelGitHubAppAttempt(attempt)
    return this.githubAppView()
  }

  /**
   * Disconnect the owner GitHub App grant and settle any local device flow.
   * @returns redacted state after disconnecting, or the still-connected state if the provider refuses.
   */
  @Remote
  async disconnectGitHubApp(): Promise<GitHubAppSignInView> {
    return this.serialGitHubAppOperation(() => this.disconnectGitHubAppInternal())
  }

  /** Disconnect after the owner-operation queue has admitted it. */
  private async disconnectGitHubAppInternal(): Promise<GitHubAppSignInView> {
    const attempt = this.currentGitHubAppAttempt
    if (attempt !== undefined && isActiveGitHubAttempt(attempt.view)) await this.cancelGitHubAppAttempt(attempt)
    const auth = this.githubAppAuth()
    if (auth === undefined) return { status: 'unavailable', attempt: null }
    try {
      await auth.disconnect()
    } catch {
      return this.githubAppView()
    }
    this.currentGitHubAppAttempt = undefined
    return this.githubAppView()
  }

  /** Read the optional service through the untyped lookup so its absence does not block account Remote mounting. */
  private githubAppAuth(): GitHubAppAuthSurface | undefined { return this.ctx.get('githubAppAuth') }

  /** Resolve provider state while hiding provider failures from the Remote caller. */
  private async githubAppStatus(auth: GitHubAppAuthSurface): Promise<'needs-auth' | 'connected'> {
    try { return await auth.status() } catch { return 'needs-auth' }
  }

  /** Build the only GitHub state projection allowed over Remote. */
  private async githubAppView(): Promise<GitHubAppSignInView> {
    const auth = this.githubAppAuth()
    if (auth === undefined) return { status: 'unavailable', attempt: null }
    return { status: await this.githubAppStatus(auth), attempt: this.currentGitHubAppAttempt?.view ?? null }
  }

  /** Accept only a complete device notice; messages are intentionally not retained. */
  private githubAppNotice(attempt: GitHubAppAttempt, notice: AuthorizationNotice): void {
    if (this.currentGitHubAppAttempt !== attempt || attempt.view.phase !== 'starting'
      || notice.url !== GITHUB_DEVICE_VERIFICATION_URL || typeof notice.code !== 'string'
      || notice.code.length === 0 || notice.code.length > 64) return
    attempt.view = { id: attempt.id, phase: 'waiting', url: notice.url, code: notice.code }
  }

  /** Replace a live attempt with a terminal phase that has no URL or code. */
  private setGitHubAppTerminal(attempt: GitHubAppAttempt, phase: 'succeeded' | 'cancelled' | 'failed'): void {
    attempt.view = { id: attempt.id, phase }
  }

  /** Serialize owner operations so disconnect cannot race a newly started flow. */
  private serialGitHubAppOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.githubAppTransition.then(operation)
    this.githubAppTransition = run.then(settleGitHubAppTransition, settleGitHubAppTransition)
    return run
  }

  /** Withdraw and await one attempt without entering the public operation queue. */
  private async cancelGitHubAppAttempt(attempt: GitHubAppAttempt): Promise<void> {
    attempt.controller.abort()
    this.ctx.authorization.cancel(GITHUB_APP_CREDENTIAL_KEY)
    await attempt.done
  }
  /**
   * Read the safe account projection.
   * @returns current account and attempt state.
   */
  @Remote
  getState(): Promise<AccountView> { return this.ctx.deepseekAccount.getState() }
  /**
   * Query display-safe Platform profile data.
   * @param client - identity of the requesting UI; the Host derives Platform request headers from it.
   * @returns profile outcome, or null when the account grant is absent or changed.
   */
  @Remote
  getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    return this.ctx.deepseekAccount.getProfile(client)
  }
  /**
   * Query Platform recharge-wallet balances.
   * @param client - identity of the requesting UI; the Host derives Platform request headers from it.
   * @returns balance outcome, or null when the account grant is absent or changed.
   */
  @Remote
  getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    return this.ctx.deepseekAccount.getBalance(client)
  }
  /**
   * Query the granted bonuses Platform has not yet recorded as displayed.
   * @param client - identity of the requesting UI; its language selects the server-authored message.
   * @returns bonuses with their account, or null when the account grant is absent or changed.
   */
  @Remote
  getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null> {
    return this.ctx.deepseekAccount.getUnnotifiedBonuses(client)
  }
  /**
   * Record one displayed bonus as notified for the account it belongs to.
   * @param accountId - account the notification was read for.
   * @param orderId - granted bonus order the user saw.
   * @param client - identity of the requesting UI; the Host derives Platform request headers from it.
   * @returns true once Platform records the acknowledgement; false when the account is absent or changed.
   */
  @Remote
  ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean> {
    return this.ctx.deepseekAccount.ackBonusNotified(accountId, orderId, client)
  }
  /**
   * Begin browser sign-in.
   * @param client - identity of the requesting UI, captured by a new attempt.
   * @param callbackOrigin - browser-accessible loopback HTTP origin.
   * @param loginSource - initiating UI, used to return from a failed exchange.
   * @returns a new or already-active login attempt.
   */
  @Remote
  startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    return this.ctx.deepseekAccount.startSignIn(client, callbackOrigin, loginSource)
  }
  /**
   * Cancel the named local attempt.
   * @param attemptId - attempt to cancel.
   * @returns settled cancellation or commit state.
   */
  @Remote
  cancelSignIn(attemptId: SignInAttemptId): Promise<AccountView> { return this.ctx.deepseekAccount.cancelSignIn(attemptId) }
  /**
   * Inspect the latest logged request providers of running tasks, including tools and retries.
   * @returns whether running work has a latest request context on the account route.
   */
  @Remote
  hasRunningAccountTasks(): boolean {
    return this.ctx.agents.list().some(isRunningAccountTask)
  }
  /**
   * Remove the local account grant and revoke it through Platform in the background, without deleting API keys.
   * @param client - identity of the requesting UI, captured for the background revocation retries.
   * @returns state after removing the local account grant.
   */
  @Remote
  signOut(client: AccountClientMetadata): Promise<AccountView> { return this.ctx.deepseekAccount.signOut(client) }
  /**
   * Subscribe to credential expiry without replaying prior notifications.
   * @param signal - stream lifetime.
   * @returns notifications emitted while subscribed.
   */
  @Remote({ mode: 'stream' })
  async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    let pending = 0
    let wake: (() => void) | undefined
    const stop = this.ctx.on('deepseek-account/session-expired', () => { pending++; wake?.() })
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (pending > 0) { pending--; yield 'session-expired'; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stop()
      signal.removeEventListener('abort', abort)
    }
  }
  /**
   * Stream the safe account projection.
   * @param signal - stream lifetime.
   * @returns initial snapshot and subsequent changes.
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<AccountView> { return this.ctx.deepseekAccount.watch(signal) }
}
export default AccountController
