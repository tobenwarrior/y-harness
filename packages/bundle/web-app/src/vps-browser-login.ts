/** Owner-approved saved website login requests for an isolated browser. */

import { setTimeout as delay } from 'node:timers/promises'
import type {} from '@yharness/bots'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { Context } from '@yharness/cordis'
import {
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
}

/** Result safe to return to the model after owner approval processing. */
export type VpsBrowserLoginResult =
  | { readonly state: 'submitted' }
  | { readonly state: 'needs-owner' }
  | { readonly state: 'unavailable' }

/** Host operation that admits only the request-creation exchange to the Bot lease. */
export type VpsBrowserLoginLease = <T>(operation: () => Promise<T>, signal: AbortSignal) => Promise<T>

/** Deterministic seams for saved-login polling tests. */
export interface VpsBrowserLoginInternals {
  /** Wait between broker status polls. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Clock used to bound owner metadata lifetime. */
  readonly now?: () => number
}

interface Entry {
  readonly request: VpsBrowserLoginRequest
  readonly expires: number
}

/**
 * Coordinates one owner-approved saved login per Bot Session without handling credentials.
 * The request-create exchange is admitted through the Computer lease; polling and owner
 * handoff continue independently so the native approval window does not occupy that lease.
 */
export class VpsBrowserLogin {
  private readonly browser: VpsIsolatedBrowser
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly pending = new Set<string>()
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Set<Promise<VpsBrowserLoginResult>>()
  private readonly closed = new AbortController()

  /**
   * @param browser - Configured isolated-browser socket client.
   * @param internals - Optional polling and clock seams for deterministic tests.
   */
  constructor(browser: VpsIsolatedBrowser, internals: VpsBrowserLoginInternals = {}) {
    this.browser = browser
    this.sleep = internals.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }))
    this.now = internals.now ?? Date.now
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
   * Read pending owner metadata for one exact Bot Session.
   * @param session - Canonical Bot Session id.
   * @returns Owner-only request metadata, or undefined after completion/expiry.
   */
  current(session: string): VpsBrowserLoginView | undefined {
    const entry = this.entries.get(session)
    if (entry === undefined) return undefined
    if (entry.expires <= this.now()) {
      this.entries.delete(session)
      return undefined
    }
    return { id: entry.request.id, origin: entry.request.origin, destination: entry.request.destination }
  }

  /**
   * Create and await one saved-login request for a direct owner Bot turn.
   * @param bot - Authorized Bot roster id.
   * @param session - Canonical Bot Session id.
   * @param lease - Admits only the request-create exchange through the Computer lease.
   * @param signal - Calling turn cancellation signal.
   * @returns State-only result; broker ids and website metadata never reach the model.
   */
  async request(bot: string, session: string, lease: VpsBrowserLoginLease, signal: AbortSignal): Promise<VpsBrowserLoginResult> {
    if (!this.authorized(bot)) throw new Error(UNAUTHORIZED)
    if (!SESSION_ID.test(session)) throw new Error(UNAVAILABLE)
    if (signal.aborted || this.closed.signal.aborted) return { state: 'unavailable' }
    if (this.pending.has(session)) throw new Error('A saved website login is already pending in this Session.')
    if (this.pending.size >= MAX_PENDING) return { state: 'unavailable' }
    this.pending.add(session)
    const running = this.run(bot, session, lease, signal)
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

  private async run(bot: string, session: string, lease: VpsBrowserLoginLease, signal: AbortSignal): Promise<VpsBrowserLoginResult> {
    const bounded = AbortSignal.any([signal, this.closed.signal, AbortSignal.timeout(REQUEST_TTL_MS)])
    let request: VpsBrowserLoginRequest | undefined
    try {
      request = await lease(() => this.browser.requestLogin(bot, session, bounded), bounded)
      this.entries.set(session, { request, expires: this.now() + REQUEST_TTL_MS })
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        if (poll > 0) await this.sleep(POLL_MS, bounded)
        const state = await this.browser.loginStatus(bot, session, request.id, bounded)
        if (state !== 'pending') return { state }
        if (this.current(session) === undefined) throw new Error(UNAVAILABLE)
      }
      throw new Error(UNAVAILABLE)
    } catch (error) {
      if (request !== undefined) {
        this.entries.delete(session)
        await this.cancel(bot, session, request.id)
      }
      void error
      return { state: 'unavailable' }
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
        ? requests.current(bot.sessionId) ?? null
        : null
      return Response.json({ request: view }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}
