/** Saved website login requests for private and shared isolated browsers. */

import { setTimeout as delay } from 'node:timers/promises'
import type {} from '@yharness/bots'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { Context } from '@yharness/cordis'
import {
  isSharedBrowserSession,
  runAuthorizedBrowserOperation,
  type VpsBrowserAdmission,
  type VpsBrowserLoginRequest,
  VpsIsolatedBrowser,
} from './vps-isolated-browser.ts'

const POLL_MS = 2_000
const REQUEST_TTL_MS = 5 * 60_000
const CANCEL_TIMEOUT_MS = 4_000
const MAX_POLLS = REQUEST_TTL_MS / POLL_MS
const MAX_PENDING = 64
const SESSION_ID = /^(?=.{1,256}$)[^\u0000-\u001f\u007f]+$/u
const UNAUTHORIZED = 'This Bot is not authorized for the isolated browser.'
const UNAVAILABLE = 'The saved website login is unavailable.'

/** Metadata returned to the authenticated owner while a request is pending. */
export interface VpsBrowserLoginView {
  /** Opaque broker request identifier used by the native owner handoff. */
  readonly id: string
  /** Website origin selected by the Bot's request. */
  readonly origin: string
  /** Exact same-origin website POST URL for the saved-login approval. */
  readonly destination: string
  /** The login was requested in a collaborator chat. */
  readonly scope?: 'shared'
  /** The owner is reviewing a new-account or verification form. */
  readonly purpose?: NonNullable<VpsBrowserLoginRequest['purpose']>
}

/** Result safe to return to the model after owner approval processing. */
export interface VpsBrowserLoginResult {
  /** Submission or owner-action status of the browser request. */
  readonly state: 'submitted' | 'needs-owner' | 'approval-required' | 'unavailable'
  /** The browser captured a new-account or verification form. */
  readonly purpose?: NonNullable<VpsBrowserLoginRequest['purpose']>
}

/** Host operation that holds the Bot's browser lease through capture and automatic submission. */
export type VpsBrowserLoginLease = <T>(operation: () => Promise<T>, signal: AbortSignal) => Promise<T>

/** Private, metadata-only delivery through the installed Vault. */
export type AutomaticVpsBrowserLogin = (
  bot: string, session: string, id: VpsBrowserLoginRequest['id'], signal: AbortSignal,
) => Promise<VpsBrowserLoginResult['state']>

/** Sign-in admission and polling options for the isolated browser. */
export interface VpsBrowserLoginOptions {
  /** Attempt automatic delivery for a private browser request through the standard Vault. */
  readonly automaticLogin?: AutomaticVpsBrowserLogin
  /** Wait between broker status polls. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Clock used to bound owner metadata lifetime. */
  readonly now?: () => number
}

interface Entry {
  readonly bot: string
  readonly request: VpsBrowserLoginRequest
  readonly expires: number
  readonly signal: AbortSignal
}

/**
 * Coordinates one saved login per Bot Session without handling credentials.
 * Capture and automatic submission hold the Computer lease. Polling and owner
 * approval run after releasing that lease so the owner can use the approval window.
 */
export class VpsBrowserLogin {
  private readonly browser: VpsIsolatedBrowser
  private readonly automaticLogin: AutomaticVpsBrowserLogin | undefined
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly pending = new Set<string>()
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Set<Promise<VpsBrowserLoginResult>>()
  private readonly closed = new AbortController()

  /**
   * @param browser - Configured isolated-browser socket client.
   * @param options - Optional automatic Vault delivery and polling configuration.
   */
  constructor(browser: VpsIsolatedBrowser, options: VpsBrowserLoginOptions = {}) {
    this.browser = browser
    this.automaticLogin = options.automaticLogin
    this.sleep = options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }))
    this.now = options.now ?? Date.now
  }

  /**
   * Check whether the broker allowlist includes a Bot.
   * @param bot - Bot roster id.
   * @returns Whether this broker may receive the Bot's request.
   */
  authorized(bot: string): boolean {
    return this.browser.authorized(bot)
  }

  /**
   * Check whether a Session has reserved its browser for Vault sign-in.
   * @param session - Canonical Bot Session id.
   * @returns Whether a request is starting, awaiting approval, or releasing its browser.
   */
  hasPending(session: string): boolean {
    return this.pending.has(session)
  }

  /**
   * Read pending owner metadata for one exact Bot Session.
   * @param session - Canonical Bot Session id.
   * @returns Owner-only request metadata, or undefined after completion/expiry.
   */
  current(session: string): VpsBrowserLoginView | undefined {
    const entry = this.entries.get(session)
    if (entry === undefined) return undefined
    if (entry.signal.aborted || entry.expires <= this.now()) {
      this.entries.delete(session)
      return undefined
    }
    return {
      id: entry.request.id, origin: entry.request.origin, destination: entry.request.destination,
      ...(isSharedBrowserSession(session) ? { scope: 'shared' as const } : {}),
      ...(entry.request.purpose === undefined ? {} : { purpose: entry.request.purpose }),
    }
  }

  /**
   * Read the next pending request for the owner of this Bot.
   * @param bot - Exact Bot roster identity.
   * @param ownerSession - Bot's canonical owner Session.
   * @returns The direct request or the earliest still-pending shared request.
   */
  currentForOwner(bot: string, ownerSession: string): VpsBrowserLoginView | undefined {
    const own = this.current(ownerSession)
    if (own !== undefined) return own
    for (const [session, entry] of this.entries) {
      if (entry.bot !== bot || !isSharedBrowserSession(session)) continue
      const shared = this.current(session)
      if (shared !== undefined) return shared
    }
    return undefined
  }

  /**
   * Create and await one owner-approved saved-login request.
   * @param bot - Authorized Bot roster id.
   * @param session - Exact owner or admitted shared Session id.
   * @param lease - Admits the capture and any automatic submission through the Computer lease.
   * @param signal - Calling turn cancellation signal.
   * @param continueShared - Admit shared browser operations and recheck access while polling.
   * @returns State-only result; broker ids and website metadata never reach the model.
   */
  request(
    bot: string, session: string, lease: VpsBrowserLoginLease, signal: AbortSignal,
    continueShared?: VpsBrowserAdmission,
  ): Promise<VpsBrowserLoginResult> {
    return this.start(bot, session, lease, signal, false, continueShared)
  }

  /**
   * Use an owner-approved automatic account during a private scheduled routine.
   * @param bot - Bot with a configured private browser.
   * @param session - Exact private owner Session.
   * @param lease - Admits the browser capture and submission while the Bot has control.
   * @param signal - Calling routine's cancellation signal.
   * @returns The submission outcome or a request for the owner to configure access.
   */
  requestForRoutine(bot: string, session: string, lease: VpsBrowserLoginLease, signal: AbortSignal): Promise<VpsBrowserLoginResult> {
    return this.start(bot, session, lease, signal, true)
  }

  private async start(
    bot: string, session: string, lease: VpsBrowserLoginLease, signal: AbortSignal,
    routine: boolean, continueShared?: VpsBrowserAdmission,
  ): Promise<VpsBrowserLoginResult> {
    if (!this.browser.authorized(bot, session)) throw new Error(UNAUTHORIZED)
    if (!SESSION_ID.test(session)) throw new Error(UNAVAILABLE)
    if (isSharedBrowserSession(session) && (routine || continueShared === undefined)) throw new Error(UNAUTHORIZED)
    if (signal.aborted || this.closed.signal.aborted) return { state: 'unavailable' }
    if (this.hasPending(session)) throw new Error('A saved website login is already pending in this Session.')
    if (this.pending.size >= MAX_PENDING) return { state: 'unavailable' }
    if (routine && this.automaticLogin === undefined) return { state: 'approval-required' }
    this.pending.add(session)
    const running = this.run(bot, session, lease, signal, routine, continueShared)
    this.flights.add(running)
    return running.finally(() => {
      this.flights.delete(running)
    })
  }

  /**
   * Stop polling and clear pending owner metadata.
   * @returns When all in-flight broker exchanges have settled.
   */
  async dispose(): Promise<void> {
    this.closed.abort()
    await Promise.allSettled(this.flights)
    this.entries.clear()
    this.pending.clear()
  }

  private async run(
    bot: string, session: string, lease: VpsBrowserLoginLease, signal: AbortSignal,
    routine: boolean, continueShared?: VpsBrowserAdmission,
  ): Promise<VpsBrowserLoginResult> {
    const bounded = AbortSignal.any([signal, this.closed.signal, AbortSignal.timeout(REQUEST_TTL_MS)])
    let request: VpsBrowserLoginRequest | undefined
    try {
      const begin = (): Promise<VpsBrowserLoginRequest> => this.browser.requestLogin(bot, session, bounded)
      const automatic = await lease(async () => {
        request = continueShared === undefined ? await begin() : await runAuthorizedBrowserOperation(continueShared, begin, bounded)
        if (isSharedBrowserSession(session)) {
          if (request.purpose !== undefined) throw new Error(UNAVAILABLE)
          return undefined
        }
        if (request.purpose !== undefined || this.automaticLogin === undefined) return undefined
        return await this.automaticLogin(bot, session, request.id, bounded)
      }, bounded)
      if (request === undefined) throw new Error(UNAVAILABLE)
      if (automatic === 'submitted') return { state: automatic }
      if (automatic === 'needs-owner') return { state: routine ? 'approval-required' : automatic }
      bounded.throwIfAborted()
      if (routine) {
        await this.cancel(bot, session, request.id)
        return {
          state: automatic === 'unavailable' ? 'unavailable' : 'approval-required',
          ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
        }
      }
      this.entries.set(session, { bot, request, expires: this.now() + REQUEST_TTL_MS, signal: bounded })
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        if (poll > 0) await this.sleep(POLL_MS, bounded)
        if (continueShared !== undefined && !await continueShared(bounded)) throw new Error(UNAVAILABLE)
        const state = await this.browser.loginStatus(bot, session, request.id, bounded)
        if (typeof state !== 'string') {
          if (continueShared === undefined) throw new Error(UNAVAILABLE)
          const id = request.id
          await runAuthorizedBrowserOperation(continueShared, () =>
            this.browser.authorizeLogin(bot, session, id, state.challenge, bounded), bounded)
        } else if (state !== 'pending') {
          if (continueShared !== undefined && !await continueShared(bounded)) throw new Error(UNAVAILABLE)
          return { state, ...(request.purpose === undefined ? {} : { purpose: request.purpose }) }
        }
        if (this.current(session) === undefined) throw new Error(UNAVAILABLE)
      }
      throw new Error(UNAVAILABLE)
    } catch (error) {
      if (request !== undefined) {
        this.entries.delete(session)
        await this.cancel(bot, session, request.id)
      }
      void error
      return { state: 'unavailable', ...(request?.purpose === undefined ? {} : { purpose: request.purpose }) }
    } finally {
      this.entries.delete(session)
      this.pending.delete(session)
    }
  }

  private async cancel(bot: string, session: string, id: string): Promise<void> {
    try {
      await this.browser.cancelLogin(bot, session, id, AbortSignal.timeout(CANCEL_TIMEOUT_MS))
    } catch (error) {
      // The broker expires requests if cancellation races a browser restart.
      void error
    }
  }
}

/**
 * Return authenticated owner metadata for the active Bot Session.
 * @param ctx - Web Host context with the server-owned Bot roster.
 * @param requests - Saved-login registry for the selected isolated browser.
 * @returns No-store GET route containing only pending request metadata.
 */
export function vpsBrowserLoginRoute(ctx: Context, requests: VpsBrowserLogin): ConnectionFetchRoute {
  return {
    path: '/api/bot-website-login',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const parameters = new URL(request.url).searchParams
      const ids = parameters.getAll('sessionId')
      const session = ids.length === 1 && parameters.size === 1 ? ids[0] : undefined
      const bot = session !== undefined && SESSION_ID.test(session)
        ? await ctx.bots.ownerBotForSession(session) : undefined
      const view = bot?.state === 'active' && requests.authorized(bot.id)
        ? requests.currentForOwner(bot.id, bot.sessionId) ?? null
        : null
      return Response.json({ request: view }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}
