/** Owner-approved service credential requests. This process handles metadata only. */

import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { BotService } from '@yharness/bots'
import type { Branded } from '@yharness/brand'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { Context } from '@yharness/cordis'
import type { SessionId } from '@yharness/session'
import { defineTool } from '@yharness/tools'

const POLL_MS = 2_000
const SOCKET_TIMEOUT_MS = 4_000
const REQUEST_MS = 10 * 60_000
const RECEIPT_MS = 2 * 60_000
const MAX_REQUESTS = 64
const MAX_REPLY_BYTES = 128
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service$/u
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const BOT = /^bot-[A-Za-z0-9][A-Za-z0-9-]{0,245}$/u
const UNAVAILABLE = 'The VPS Vault could not confirm the secure request.'
const VAULT_CHAT_FLAG = '__YH_BOT_VAULT_REQUESTS__'

/** One exact service and key a Bot can ask its owner to enter. */
export interface VpsVaultCredential {
  /** Administrator-enabled system service receiving the key. */
  readonly unit: string
  /** Exact key name within the service's private credential directory. */
  readonly name: string
}

/** A credential request grant for a single owner Bot. */
export interface VpsVaultGrant extends VpsVaultCredential {
  /** Exact Bot roster ID. */
  readonly bot: string
}

/** Trusted Web Host configuration for the VPS Vault request listener. */
export interface VpsVaultRequestsConfig {
  /** Absolute path to the local, Cloud-account-only broker socket. */
  readonly socketPath: string
  /** Exact Bot, system service and key combinations that may be requested. */
  readonly grants: VpsVaultGrant[]
}

type RequestId = Branded<'VpsVaultRequestId'>
type Receipt = 'saved' | 'cancelled'
type State = 'pending' | Receipt
type Command = ({ readonly action: 'create'; readonly id: RequestId } & VpsVaultCredential)
  | { readonly action: 'status' | 'cancel'; readonly id: RequestId }

/** Metadata shown to the owner of the live Bot conversation. */
export interface VpsVaultRequestView extends VpsVaultCredential {
  /** Opaque identifier that the native Vault resolves over the owner's SSH connection. */
  readonly id: RequestId
  /** Last acknowledged state of the request. */
  readonly state: State
}

interface Entry {
  readonly view: VpsVaultRequestView
  readonly expires: number
}

/**
 * Install the owner request tool and its read-only chat route.
 * @param ctx - Web Host context.
 * @param config - Owner-managed broker address and exact credential grants.
 */
export function mountVpsVaultRequests(ctx: Context, config: VpsVaultRequestsConfig): void {
  const requests = new VpsVaultRequests(config)
  ctx.effect(() => () => requests.dispose(), 'vps-vault: cancel pending requests')
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: VAULT_CHAT_FLAG, value: true })
  })
  ctx.inject(['bots', 'connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register(vpsVaultRequestRoute(scope, requests)), 'vps-vault: chat request metadata')
  })
  ctx.inject(['bots'], (scope) => {
    scope.on('agent/created', async ({ agent }) => {
      const bot = await scope.bots.ownerBotForSession(agent.id)
      if (bot === undefined) return
      await agent.ctx.inject(['tools'], (toolCtx) => {
        registerVpsVaultRequestTool(toolCtx, scope.bots, requests, bot.id, bot.sessionId)
      })
    })
  })
}

function registerVpsVaultRequestTool(
  ctx: Context, bots: BotService, requests: VpsVaultRequests, bot: string, session: SessionId,
): void {
  const grants = requests.credentialsFor(bot)
  if (grants.length === 0) return
  const tool = defineTool({
    name: 'request_vps_secret',
    description: 'Ask the owner to enter an API key in the secure Y Harness Vault. '
      + 'The owner enters the value in the Mac app. You receive only the outcome. '
      + 'Never ask the owner to paste a credential into chat. '
      + `Allowed service and key pairs: ${grants.map(({ unit, name }) => `${unit} / ${name}`).join(', ')}.`,
    parameters: {
      unit: { type: 'string', required: true, enum: [...new Set(grants.map(grant => grant.unit))] },
      name: { type: 'string', required: true, enum: [...new Set(grants.map(grant => grant.name))] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { state: { type: 'string', enum: ['saved', 'cancelled'], required: true } },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.state === 'saved'
          ? 'The key is saved in the VPS Vault. The service loads it on its next start.'
          : 'The owner did not save a key through this request.',
      }],
    },
    async execute(args, call) {
      if (Object.keys(args).length !== 2) throw new Error('A secure request accepts only the service and key name.')
      const agent = call.agent
      if (agent?.id !== session || !await bots.isDirectOwnerTurn(agent, call.signal)) {
        throw new Error('A secure request requires a direct owner Bot turn.')
      }
      return requests.request(bot, session, args, call.signal)
    },
  })
  ctx.effect(() => ctx.tools.register({
    ...tool,
    parameters: { ...tool.parameters, additionalProperties: false },
  }), 'vps-vault: secure credential request')
}

/**
 * Return the exact owner-authenticated metadata route for the chat card.
 * @param ctx - Host context that resolves the operator-owned Bot Session.
 * @param requests - Live broker request registry.
 * @returns An HTTP route with no credential entry or retrieval operation.
 */
export function vpsVaultRequestRoute(ctx: Context, requests: VpsVaultRequests): ConnectionFetchRoute {
  return {
    path: '/api/bot-vault-request',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const parameters = new URL(request.url).searchParams
      const ids = parameters.getAll('sessionId')
      const id = ids.length === 1 && parameters.size === 1 ? ids[0] : undefined
      const bot = id !== undefined && /^(?=.{1,256}$)[^\u0000-\u001f\u007f]+$/u.test(id)
        ? await ctx.bots.ownerBotForSession(id) : undefined
      return Response.json({
        request: bot?.state === 'active' && requests.authorized(bot.id) ? requests.current(bot.sessionId) ?? null : null,
      }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}

function credentialIsValid({ unit, name }: VpsVaultCredential): boolean {
  return unit === unit.trim() && name === name.trim()
    && SERVICE.test(unit) && !unit.endsWith('@.service') && KEY.test(name)
}

function decodedState(data: string): State {
  const reply: unknown = JSON.parse(data)
  if (reply === null || typeof reply !== 'object' || Object.keys(reply).length !== 1 || !('state' in reply)
    || (reply.state !== 'pending' && reply.state !== 'saved' && reply.state !== 'cancelled')) {
    throw new Error(UNAVAILABLE)
  }
  return reply.state
}

function exchange(path: string, command: Command, signal: AbortSignal): Promise<State> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const socket = createConnection({ path })
    const deadline = setTimeout(fail, SOCKET_TIMEOUT_MS)
    const buffer: Buffer[] = []
    let length = 0
    let received: State | undefined
    let failed = false
    function fail(): void {
      failed = true
      socket.destroy()
    }
    signal.addEventListener('abort', fail, { once: true })
    socket.once('error', fail)
    socket.once('connect', () => { socket.end(JSON.stringify(command)) })
    socket.on('data', (chunk: Buffer) => {
      length += chunk.byteLength
      if (length > MAX_REPLY_BYTES) fail()
      else buffer.push(chunk)
    })
    socket.once('end', () => {
      if (failed) return
      try { received = decodedState(Buffer.concat(buffer).toString('utf8')) }
      catch (_error) { /* The broker's raw response never leaves this transport. */ }
    })
    socket.once('close', () => {
      clearTimeout(deadline)
      signal.removeEventListener('abort', fail)
      if (failed || received === undefined || signal.aborted) reject(new Error(UNAVAILABLE))
      else resolve(received)
    })
  })
}

/** Publishes one outstanding secure request per owner Session. */
export class VpsVaultRequests {
  private readonly pending = new Set<SessionId>()
  private readonly entries = new Map<SessionId, Entry>()
  private readonly closed = new AbortController()
  private readonly flights = new Set<Promise<{ readonly state: Receipt }>>()
  private readonly socketPath: string
  private readonly grants: readonly VpsVaultGrant[]

  /** @param config - Owner-managed broker address and exact request grants. */
  constructor(config: VpsVaultRequestsConfig) {
    if (process.platform === 'win32' || !isAbsolute(config.socketPath)
      || !config.socketPath.startsWith('/') || config.socketPath.includes('\0')) {
      throw new Error('VPS Vault request socketPath must be an absolute Unix path.')
    }
    if (config.grants.length === 0 || config.grants.length > MAX_REQUESTS || config.grants.some(grant =>
      !BOT.test(grant.bot) || grant.bot !== grant.bot.trim() || !credentialIsValid(grant))) {
      throw new Error('VPS Vault requests require exact Bot, service and key grants.')
    }
    this.socketPath = config.socketPath
    this.grants = config.grants.map(grant => ({ ...grant }))
  }

  /**
   * Check the configured Bot and exact credential grant.
   * @param bot - Bot identity assigned by the owner roster.
   * @param credential - Optional exact service and name, required at execution.
   * @returns Whether the Bot has the requested grant.
   */
  authorized(bot: string, credential?: VpsVaultCredential): boolean {
    return this.grants.some(grant => grant.bot === bot
      && (credential === undefined || (grant.unit === credential.unit && grant.name === credential.name)))
  }

  /**
   * List the metadata the selected Bot can use to request a credential.
   * @param bot - Bot identity assigned by the owner roster.
   * @returns Exact service and key combinations for that Bot.
   */
  credentialsFor(bot: string): readonly VpsVaultCredential[] {
    return this.grants.filter(grant => grant.bot === bot)
      .map(({ unit, name }) => ({ unit, name }))
  }

  /**
   * Read the ephemeral request card for this exact Session.
   * @param session - Already authorized owner Bot Session.
   * @returns Current pending request or a short-lived final receipt.
   */
  current(session: SessionId): VpsVaultRequestView | undefined {
    const entry = this.entries.get(session)
    if (entry !== undefined && entry.expires <= Date.now()) {
      this.entries.delete(session)
      return undefined
    }
    return entry?.view
  }

  /**
   * Wait for the owner-only Vault to save or dismiss one credential request.
   * @param bot - Bot identity bound to the invoking Agent by the owner roster.
   * @param session - Exact Session that initiated the request.
   * @param credential - Metadata only. The broker enforces its current service policy.
   * @param signal - Calling turn cancellation.
   * @returns The final result without the credential value or request identifier.
   */
  async request(
    bot: string, session: SessionId, credential: VpsVaultCredential, signal: AbortSignal,
  ): Promise<{ readonly state: Receipt }> {
    if (!this.authorized(bot, credential)) throw new Error('This Bot has no Vault grant for that credential.')
    signal.throwIfAborted()
    this.closed.signal.throwIfAborted()
    if (this.pending.has(session)) throw new Error('A secure request is already pending in this chat.')
    if (this.pending.size >= MAX_REQUESTS) throw new Error(UNAVAILABLE)
    this.pending.add(session)
    this.entries.delete(session)
    const running = this.waitForReceipt(session, credential, AbortSignal.any([signal, this.closed.signal]))
    this.flights.add(running)
    try { return await running }
    finally {
      this.flights.delete(running)
      this.pending.delete(session)
    }
  }

  /** Cancel outstanding broker requests and clear their UI receipts. */
  async dispose(): Promise<void> {
    this.closed.abort()
    await Promise.allSettled(this.flights)
    this.entries.clear()
  }

  private publish(session: SessionId, view: VpsVaultRequestView, expires: number): void {
    if (this.entries.size >= MAX_REQUESTS && !this.entries.has(session)) {
      for (const [id] of this.entries) {
        if (this.pending.has(id)) continue
        this.entries.delete(id)
        break
      }
    }
    this.entries.set(session, { view, expires })
  }

  private async waitForReceipt(
    session: SessionId, credential: VpsVaultCredential, signal: AbortSignal,
  ): Promise<{ readonly state: Receipt }> {
    const id = randomBytes(16).toString('hex') as RequestId
    const expires = Date.now() + REQUEST_MS
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)])
    let state: State
    try {
      state = await exchange(this.socketPath, { action: 'create', id, unit: credential.unit, name: credential.name }, bounded)
      if (state === 'pending') this.publish(session, { id, ...credential, state }, expires)
      while (state === 'pending') {
        await delay(POLL_MS, undefined, { signal: bounded })
        state = await exchange(this.socketPath, { action: 'status', id }, bounded)
      }
    } catch (_error) {
      try {
        state = await exchange(this.socketPath, { action: 'cancel', id }, AbortSignal.timeout(SOCKET_TIMEOUT_MS))
      } catch (_cancelError) {
        // The broker also expires pending requests whose live Host stops renewing the lease.
        this.entries.delete(session)
        throw new Error(UNAVAILABLE)
      }
      if (state === 'pending') {
        this.entries.delete(session)
        throw new Error(UNAVAILABLE)
      }
    }
    this.publish(session, { id, ...credential, state }, Date.now() + RECEIPT_MS)
    return { state }
  }
}
