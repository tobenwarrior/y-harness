/** Temporary owner controls for an exact shared Bot browser. */

import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { BotId } from '@yharness/bots'
import { brandString } from '@yharness/brand'
import type { SessionId } from '@yharness/session/types'
import type { ComputerSignInResult, VpsComputer } from './computer.ts'
import type { ComputerSignInRouteTarget, SharedBrowserHandoffTarget, SharedComputerSignInRequest } from './computer-api.ts'
import {
  isSharedBrowserSession, runAuthorizedBrowserOperation, type VpsBrowserAdmission, type VpsBrowserHandoff,
  type VpsBrowserHandoffLease, type VpsIsolatedBrowser,
} from './vps-isolated-browser.ts'

const HANDOFF_TIMEOUT_MS = 10 * 60_000
const ADMISSION_POLL_MS = 2_000
const DISCARD_TIMEOUT_MS = 4_000
const UNAVAILABLE = 'The shared browser sign-in is unavailable.'

/** Routes the owner can use while an admitted shared turn is waiting for sign-in. */
export interface VpsBrowserHandoffView extends ComputerSignInRouteTarget {
  readonly ownerSessionId: SessionId
  readonly botId: BotId
  readonly computer: VpsComputer
  readonly status: () => SharedComputerSignInRequest | undefined
  readonly navigate: (url: string, signal: AbortSignal) => Promise<void>
}

interface PendingHandoff {
  readonly ownerSessionId: SessionId
  readonly target: SharedBrowserHandoffTarget
  readonly finished: PromiseWithResolvers<ComputerSignInResult>
  view: VpsBrowserHandoffView | undefined
}

/** Bind one owner-only sign-in request to the same isolated page used by a shared turn. */
export class VpsBrowserHandoffs {
  private readonly byOwner = new Map<SessionId, PendingHandoff>()
  private readonly byTarget = new Map<string, PendingHandoff>()
  private readonly closed = new AbortController()

  /** @param browser - Isolated browser worker client. */
  constructor(private readonly browser: VpsIsolatedBrowser) {}

  /** Read pending metadata exclusively for the canonical owner Bot Session.
   * @param botId - Active owner Bot.
   * @param ownerSessionId - The Bot's durable owner Session.
   * @returns Current owner-only metadata.
   */
  status(botId: BotId, ownerSessionId: SessionId): SharedComputerSignInRequest | undefined {
    const view = this.byOwner.get(ownerSessionId)?.view
    return view?.botId === botId ? view.status() : undefined
  }

  /** Find the temporary viewer route while its handoff is live.
   * @param target - Opaque address from an authenticated owner route request.
   * @returns A live view whose owner Bot the route must revalidate.
   */
  target(target: string): VpsBrowserHandoffView | undefined {
    const view = this.byTarget.get(target)?.view
    return view?.status() === undefined ? undefined : view
  }

  /** Start a sign-in request from a shared private or group Bot turn.
   * @param botId - Bot bound to this shared turn.
   * @param ownerSessionId - The Bot's durable owner Session.
   * @param session - Calling shared Session.
   * @param computer - Calling turn's ordinary browser controller.
   * @param authorize - Recheck exact membership and start broker operations under the authority lock.
   * @param signal - Calling turn cancellation.
   * @returns Whether the owner returned the page, declined, or the request ended without handback.
   */
  async request(
    botId: BotId, ownerSessionId: SessionId, session: SessionId, computer: VpsComputer,
    authorize: VpsBrowserAdmission, signal: AbortSignal,
  ): Promise<ComputerSignInResult> {
    if (signal.aborted || this.closed.signal.aborted || this.byOwner.has(ownerSessionId)
      || !isSharedBrowserSession(session) || !this.browser.authorized(botId, session)) return 'interrupted'
    const entry: PendingHandoff = {
      ownerSessionId, target: brandString<SharedBrowserHandoffTarget>(`handoff-${randomUUID()}`),
      finished: Promise.withResolvers<ComputerSignInResult>(), view: undefined,
    }
    const handoff: VpsBrowserHandoff = {
      bot: botId, session, lease: brandString<VpsBrowserHandoffLease>(randomBytes(16).toString('hex')),
    }
    this.byOwner.set(ownerSessionId, entry)
    let result: ComputerSignInResult = 'interrupted'
    try {
      result = await this.run(entry, botId, handoff, computer, authorize, signal)
    } catch (error) {
      // Worker or viewer failures carry no details back into the shared chat.
      void error
    } finally {
      this.byOwner.delete(ownerSessionId)
      entry.finished.resolve(result)
    }
    return result
  }

  /** Stop all requests and wait for their private pages to be released or discarded.
   * @returns When all Host-side handoff work has settled.
   */
  async dispose(): Promise<void> {
    this.closed.abort()
    await Promise.all([...this.byOwner.values()].map(entry => entry.finished.promise))
  }

  private async run(
    entry: PendingHandoff, botId: BotId, handoff: VpsBrowserHandoff, computer: VpsComputer,
    authorize: VpsBrowserAdmission, signal: AbortSignal,
  ): Promise<ComputerSignInResult> {
    const revoked = new AbortController()
    const bounded = AbortSignal.any([signal, this.closed.signal, revoked.signal, AbortSignal.timeout(HANDOFF_TIMEOUT_MS)])
    const stopViewer = new AbortController()
    const ownerLifetime = AbortSignal.any([bounded, stopViewer.signal])
    const handoffState = { attempted: false, completed: false }
    let ownerComputer: VpsComputer | undefined
    let watcher: Promise<void> | undefined
    const closeView = async (): Promise<void> => {
      this.byTarget.delete(entry.target)
      entry.view = undefined
      stopViewer.abort()
      await ownerComputer?.dispose()
    }
    try {
      const origin = await computer.runWhileBotControls(() => runAuthorizedBrowserOperation(authorize, () => {
        handoffState.attempted = true
        return this.browser.beginHandoff(handoff, bounded)
      }, bounded), bounded)
      bounded.throwIfAborted()
      const owner = ownerComputer = this.browser.handoffComputer(handoff, authorize, ownerLifetime)
      const waiting = owner.requestSignIn(bounded)
      entry.view = {
        ownerSessionId: entry.ownerSessionId,
        botId,
        computer: owner,
        status: () => {
          const request = ownerLifetime.aborted ? undefined : owner.signInRequest()
          return request === undefined ? undefined : { ...request, targetSessionId: entry.target, origin }
        },
        answer: async (id, action, viewer, requestSignal) => {
          const live = AbortSignal.any([ownerLifetime, requestSignal])
          if (!await authorize(live)) throw new Error(UNAVAILABLE)
          const mode = await owner.answerSignIn(id, action, viewer, live)
          if (action !== 'take') {
            const result = await entry.finished.promise
            if (action === 'complete' && result !== 'completed') throw new Error(UNAVAILABLE)
          }
          return mode
        },
        navigate: (url, requestSignal) => {
          const live = AbortSignal.any([ownerLifetime, requestSignal])
          return runAuthorizedBrowserOperation(authorize, () => this.browser.navigateHandoff(handoff, url, live), live)
        },
      }
      this.byTarget.set(entry.target, entry)
      watcher = this.watchAdmission(authorize, ownerLifetime, revoked)
      const result = await waiting
      await closeView()
      if (result !== 'completed') return result
      await runAuthorizedBrowserOperation(authorize, () => this.browser.endHandoff(handoff, 'complete', bounded), bounded)
      handoffState.completed = true
      return 'completed'
    } finally {
      await closeView()
      await watcher
      if (handoffState.attempted && !handoffState.completed) {
        try {
          await this.browser.endHandoff(handoff, 'discard', AbortSignal.timeout(DISCARD_TIMEOUT_MS))
        } catch (error) {
          // The worker closes an abandoned lease when it expires.
          void error
        }
      }
    }
  }

  private async watchAdmission(
    authorize: VpsBrowserAdmission, lifetime: AbortSignal, revoked: AbortController,
  ): Promise<void> {
    try {
      while (!lifetime.aborted) {
        await delay(ADMISSION_POLL_MS, undefined, { signal: lifetime, ref: false })
        if (!await authorize(lifetime)) break
      }
    } catch (error) {
      // A failed check ends the handoff just like a revoked membership.
      void error
    }
    if (!lifetime.aborted) revoked.abort()
  }
}
