/** Owner-approved VPS service credential requests over a metadata-only socket. */

import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { BotService, BotSharedVaultRequests } from '@yharness/bots'
import type { Branded } from '@yharness/brand'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { Context } from '@yharness/cordis'
import type { SessionId } from '@yharness/session'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@yharness/tools'

const POLL_MS = 2_000
const SOCKET_TIMEOUT_MS = 4_000
const REQUEST_MS = 10 * 60_000
const RECEIPT_MS = 2 * 60_000
const MAX_REQUESTS = 64
const MAX_REPLY_BYTES = 128
const MAX_LIST_BYTES = 24 * 1024
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service$/u
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const BOT = /^bot-[A-Za-z0-9][A-Za-z0-9-]{0,245}$/u
const UNAVAILABLE = 'The VPS Vault could not confirm the secure request.'
const VAULT_CHAT_FLAG = '__YH_BOT_VAULT_REQUESTS__'
const SHARED_VAULT_CHAT_FLAG = '__YH_BOT_SHARED_VAULT_REQUESTS__'

/** Local socket installed by the VPS Vault command. */
export const VPS_VAULT_REQUEST_SOCKET = '/run/yharness-vault/cloud-requests.sock'

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
  /** Explicit Web profile grants. Omit or set to null to use the Vault's current Bot-specific grants. */
  readonly grants?: VpsVaultGrant[] | null
  /** Allow explicitly granted shared requests. The standard Vault-managed broker enables this by default. */
  readonly sharedRequests?: boolean
}

type RequestId = Branded<'VpsVaultRequestId'>
type ChallengeId = Branded<'VpsVaultApprovalChallenge'>
type Receipt = 'saved' | 'cancelled'
type State = 'pending' | Receipt
type ApprovalChallenge = { readonly challenge: ChallengeId }
type SharedAdmission = (signal: AbortSignal, start?: () => void) => Promise<boolean>
type RequestCommand = ({ readonly action: 'create'; readonly id: RequestId } & VpsVaultCredential)
  | { readonly action: 'status' | 'cancel'; readonly id: RequestId }
  | { readonly action: 'authorize'; readonly id: RequestId; readonly challenge: ChallengeId }
type Command = (RequestCommand & { readonly bot?: string; readonly scope?: 'shared' })
  | { readonly action: 'list'; readonly bot: string; readonly scope?: 'shared' }

/** Metadata shown to the owner of the live Bot conversation. */
export interface VpsVaultRequestView extends VpsVaultCredential {
  /** Opaque identifier that the native Vault resolves over the owner's SSH connection. */
  readonly id: RequestId
  /** Last acknowledged state of the request. */
  readonly state: State
  /** Marks a request initiated in an isolated shared Bot chat. */
  readonly scope?: 'shared'
}

interface Entry {
  readonly view: VpsVaultRequestView
  readonly expires: number
}

/**
 * Install the owner request tool and its read-only chat route.
 * @param ctx - Web Host context.
 * @param config - Vault broker address and optional Web profile grants.
 */
export function mountVpsVaultRequests(ctx: Context, config: VpsVaultRequestsConfig): void {
  const requests = new VpsVaultRequests(config)
  ctx.effect(() => () => requests.dispose(), 'vps-vault: cancel pending requests')
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: VAULT_CHAT_FLAG, value: true })
    if (requests.sharedEnabled) table.push({ kind: 'global', name: SHARED_VAULT_CHAT_FLAG, value: true })
  })
  if (requests.sharedEnabled) {
    const provider: BotSharedVaultRequests = {
      toolForSession(_scope, agent, botId, ownerSessionId, authorized) {
        return vpsVaultRequestTool(requests, botId, ownerSessionId, async call => call.agent === agent, authorized)
      },
    }
    ctx.provide('botSharedVaultRequests', provider)
  }
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
  const tool = vpsVaultRequestTool(requests, bot, session, async ({ agent, signal }) =>
    agent?.id === session && await bots.isDirectOwnerTurn(agent, signal))
  if (tool !== undefined) ctx.effect(() => ctx.tools.register(tool), 'vps-vault: secure credential request')
}

function vpsVaultRequestTool(
  requests: VpsVaultRequests,
  bot: string,
  ownerSession: SessionId,
  allowTurn: (call: ToolRunContext) => Promise<boolean>,
  sharedAdmission?: SharedAdmission,
): ToolDefinition | undefined {
  const grants = requests.credentialsFor(bot)
  const managed = requests.brokerManaged
  if (!managed && grants.length === 0) return undefined
  const receipt = {
    type: 'object',
    additionalProperties: false,
    properties: { state: { type: 'string', enum: ['saved', 'cancelled'], required: true } },
  } as const
  const discovery = {
    type: 'object',
    additionalProperties: false,
    properties: {
      credentials: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: { unit: { type: 'string', required: true }, name: { type: 'string', required: true } },
        },
      },
    },
  } as const
  const tool = defineTool({
    name: 'request_vps_secret',
    description: 'Ask the owner to enter an API key in the secure Y Harness Vault. '
      + 'The owner enters the value in the Mac app. You receive only the outcome. '
      + 'Never ask the owner to paste a credential into chat. '
      + (managed
        ? 'Call with no arguments to see the allowed service and key pairs. Pass both unit and name to request a key.'
        : `Allowed service and key pairs: ${grants.map(({ unit, name }) => `${unit} / ${name}`).join(', ')}.`),
    parameters: {
      unit: managed ? { type: 'string' } : { type: 'string', required: true, enum: [...new Set(grants.map(grant => grant.unit))] },
      name: managed ? { type: 'string' } : { type: 'string', required: true, enum: [...new Set(grants.map(grant => grant.name))] },
    },
    output: {
      schema: { oneOf: [receipt, discovery] },
      render: (_args, result) => [{
        type: 'text',
        text: 'credentials' in result
          ? renderCredentials(result.credentials)
          : result.state === 'saved'
            ? 'The key is saved in the VPS Vault. The service loads it on its next start.'
            : 'The owner did not save a key through this request.',
      }],
    },
    async execute(args, call) {
      if (!await allowTurn(call)) {
        throw new Error(sharedAdmission === undefined ? 'A secure request requires a direct owner Bot turn.' : UNAVAILABLE)
      }
      const fields = Object.keys(args).length
      if (managed && fields === 0) return { credentials: await requests.discover(bot, call.signal, sharedAdmission) }
      if (fields !== 2 || args.unit === undefined || args.name === undefined) {
        throw new Error('A secure request accepts only the service and key name.')
      }
      return requests.request(bot, ownerSession, { unit: args.unit, name: args.name }, call.signal, sharedAdmission)
    },
  })
  return { ...tool, parameters: { ...tool.parameters, additionalProperties: false } }
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
        request: bot?.state === 'active' ? requests.current(bot.sessionId) ?? null : null,
      }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}

/**
 * Report whether the connected Web Host uses the local Vault's Bot grants.
 * @param config - Effective Vault request configuration for this Web Host.
 * @returns An owner API route that exposes the mode without policy entries or socket paths.
 */
export function vpsVaultAccessRoute(config: VpsVaultRequestsConfig | null | undefined): ConnectionFetchRoute {
  const mode = config == null ? 'disabled'
    : config.socketPath === VPS_VAULT_REQUEST_SOCKET && config.grants == null ? 'managed' : 'external'
  return {
    path: '/api/bot-vault-access',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return Response.json({ mode }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}

function credentialIsValid({ unit, name }: VpsVaultCredential): boolean {
  return unit === unit.trim() && name === name.trim()
    && SERVICE.test(unit) && !unit.endsWith('@.service') && KEY.test(name)
}

function validBot(bot: string): boolean {
  return bot === bot.trim() && BOT.test(bot)
}

function renderCredentials(credentials: readonly VpsVaultCredential[]): string {
  if (credentials.length === 0) return 'This Bot has no VPS Vault grants.'
  return `Allowed service and key pairs:\n${credentials.map(({ unit, name }) => `${unit} / ${name}`).join('\n')}`
}

function decodedState(data: string): State | ApprovalChallenge {
  const reply: unknown = JSON.parse(data)
  if (reply === null || typeof reply !== 'object' || !('state' in reply)) throw new Error(UNAVAILABLE)
  const fields = Object.keys(reply).length
  if (fields === 1 && (reply.state === 'pending' || reply.state === 'saved' || reply.state === 'cancelled')) return reply.state
  if (fields === 2 && reply.state === 'awaiting-authorization' && 'challenge' in reply
    && typeof reply.challenge === 'string' && /^[a-f0-9]{32}$/u.test(reply.challenge)) {
    return { challenge: reply.challenge as ChallengeId }
  }
  throw new Error(UNAVAILABLE)
}

function decodedCredentials(data: string): VpsVaultCredential[] {
  const reply: unknown = JSON.parse(data)
  if (reply === null || typeof reply !== 'object' || Object.keys(reply).length !== 1 || !('credentials' in reply)
    || !Array.isArray(reply.credentials) || reply.credentials.length > MAX_REQUESTS) throw new Error(UNAVAILABLE)
  return reply.credentials.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Object.keys(entry).length !== 2
      || !('unit' in entry) || !('name' in entry) || typeof entry.unit !== 'string' || typeof entry.name !== 'string') {
      throw new Error(UNAVAILABLE)
    }
    const credential = { unit: entry.unit, name: entry.name }
    if (!credentialIsValid(credential)) throw new Error(UNAVAILABLE)
    return credential
  })
}

function exchange<T>(
  path: string, command: Command, signal: AbortSignal, decode: (reply: string) => T, maxBytes: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const socket = createConnection({ path })
    const deadline = setTimeout(fail, SOCKET_TIMEOUT_MS)
    const buffer: Buffer[] = []
    let length = 0
    let received: T | undefined
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
      if (length > maxBytes) fail()
      else buffer.push(chunk)
    })
    socket.once('end', () => {
      if (failed) return
      try { received = decode(Buffer.concat(buffer).toString('utf8')) }
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

async function runAdmitted<T>(authorize: SharedAdmission, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined
  try {
    const admitted = await authorize(signal, () => {
      signal.throwIfAborted()
      started = operation()
      void started.catch(() => undefined)
    })
    if (!admitted || started === undefined) throw new Error(UNAVAILABLE)
    return await started
  } catch (error) {
    await started?.catch(() => undefined)
    throw error
  }
}

/** Publishes one outstanding secure request per owner Session. */
export class VpsVaultRequests {
  private readonly pending = new Set<SessionId>()
  private readonly entries = new Map<SessionId, Entry>()
  private readonly closed = new AbortController()
  private readonly flights = new Set<Promise<{ readonly state: Receipt }>>()
  private readonly socketPath: string
  private readonly grants: readonly VpsVaultGrant[] | undefined
  /** Whether the Host can request keys using explicit shared Vault grants. */
  readonly sharedEnabled: boolean

  /** @param config - Vault broker address and optional Web profile grants. */
  constructor(config: VpsVaultRequestsConfig) {
    if (process.platform === 'win32' || !isAbsolute(config.socketPath)
      || !config.socketPath.startsWith('/') || config.socketPath.includes('\0')) {
      throw new Error('VPS Vault request socketPath must be an absolute Unix path.')
    }
    if (config.grants != null && (config.grants.length === 0 || config.grants.length > MAX_REQUESTS
      || config.grants.some(grant => !validBot(grant.bot) || !credentialIsValid(grant)))) {
      throw new Error('VPS Vault requests require exact Bot, service and key grants.')
    }
    this.socketPath = config.socketPath
    this.grants = config.grants?.map(grant => ({ ...grant }))
    this.sharedEnabled = config.sharedRequests ?? (this.brokerManaged && this.socketPath === VPS_VAULT_REQUEST_SOCKET)
    if (this.sharedEnabled && !this.brokerManaged) throw new Error('Shared Vault requests require Vault-managed grants.')
  }

  /** Whether the Vault owns the Bot grants. */
  get brokerManaged(): boolean {
    return this.grants === undefined
  }

  /**
   * List grants from the explicit Web profile.
   * @param bot - Bot identity assigned by the owner roster.
   * @returns Exact service and key combinations for that Bot.
   */
  credentialsFor(bot: string): readonly VpsVaultCredential[] {
    return (this.grants ?? []).filter(grant => grant.bot === bot)
      .map(({ unit, name }) => ({ unit, name }))
  }

  /**
   * List the Vault's current request grants for one Bot.
   * @param bot - Bot identity assigned by the owner roster.
   * @param signal - Calling turn cancellation.
   * @param sharedAdmission - Live membership check for a shared Bot turn.
   * @returns Exact service and key names available to the selected Bot.
   */
  async discover(bot: string, signal: AbortSignal, sharedAdmission?: SharedAdmission): Promise<VpsVaultCredential[]> {
    if (!this.brokerManaged || !validBot(bot)) throw new Error(UNAVAILABLE)
    const bounded = AbortSignal.any([signal, this.closed.signal])
    if (sharedAdmission === undefined) {
      return exchange(this.socketPath, { action: 'list', bot }, bounded, decodedCredentials, MAX_LIST_BYTES)
    }
    if (!this.sharedEnabled || !await sharedAdmission(bounded)) throw new Error(UNAVAILABLE)
    const result = await exchange(this.socketPath, { action: 'list', bot, scope: 'shared' }, bounded, decodedCredentials, MAX_LIST_BYTES)
    if (!await sharedAdmission(bounded)) throw new Error(UNAVAILABLE)
    return result
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
   * @param sharedAdmission - Current shared turn admission with a starter for owner-approved writes.
   * @returns The final result without the credential value or request identifier.
   */
  async request(
    bot: string, session: SessionId, credential: VpsVaultCredential, signal: AbortSignal, sharedAdmission?: SharedAdmission,
  ): Promise<{ readonly state: Receipt }> {
    if (sharedAdmission !== undefined && !this.sharedEnabled) throw new Error(UNAVAILABLE)
    if (!validBot(bot) || !credentialIsValid(credential) || (this.grants !== undefined && !this.grants.some(grant =>
      grant.bot === bot && grant.unit === credential.unit && grant.name === credential.name))) {
      throw new Error('This Bot has no Vault grant for that credential.')
    }
    signal.throwIfAborted()
    this.closed.signal.throwIfAborted()
    if (this.pending.has(session)) throw new Error('A secure request is already pending in this chat.')
    if (this.pending.size >= MAX_REQUESTS) throw new Error(UNAVAILABLE)
    this.pending.add(session)
    this.entries.delete(session)
    const running = this.waitForReceipt(bot, session, credential, AbortSignal.any([signal, this.closed.signal]), sharedAdmission)
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
    bot: string, session: SessionId, credential: VpsVaultCredential, signal: AbortSignal, sharedAdmission?: SharedAdmission,
  ): Promise<{ readonly state: Receipt }> {
    const id = randomBytes(16).toString('hex') as RequestId
    const expires = Date.now() + REQUEST_MS
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)])
    const scope = sharedAdmission === undefined ? {} : { scope: 'shared' as const }
    const send = (command: RequestCommand, requestSignal: AbortSignal) => exchange(
      this.socketPath, this.brokerManaged ? { ...command, bot, ...scope } : command, requestSignal, decodedState, MAX_REPLY_BYTES,
    )
    const create = () => send({ action: 'create', id, unit: credential.unit, name: credential.name }, bounded)
    let state: State | ApprovalChallenge
    try {
      state = await (sharedAdmission === undefined ? create() : runAdmitted(sharedAdmission, bounded, create))
      if (typeof state !== 'string') throw new Error(UNAVAILABLE)
      if (state === 'pending') this.publish(session, { id, ...credential, state, ...scope }, expires)
      while (state === 'pending') {
        await delay(POLL_MS, undefined, { signal: bounded })
        if (sharedAdmission !== undefined && !await sharedAdmission(bounded)) throw new Error(UNAVAILABLE)
        const reply = await send({ action: 'status', id }, bounded)
        if (typeof reply === 'string') {
          state = reply
          continue
        }
        if (sharedAdmission === undefined) throw new Error(UNAVAILABLE)
        const admission = await runAdmitted(sharedAdmission, bounded, () =>
          send({ action: 'authorize', id, challenge: reply.challenge }, bounded))
        if (admission !== 'pending') throw new Error(UNAVAILABLE)
      }
    } catch (_error) {
      try {
        state = await send({ action: 'cancel', id }, AbortSignal.timeout(SOCKET_TIMEOUT_MS))
      } catch (_cancelError) {
        // The broker expires requests whose Host stops renewing the lease.
        this.entries.delete(session)
        throw new Error(UNAVAILABLE)
      }
      if (state !== 'cancelled' && state !== 'saved') {
        this.entries.delete(session)
        throw new Error(UNAVAILABLE)
      }
    }
    this.publish(session, { id, ...credential, state, ...scope }, Date.now() + RECEIPT_MS)
    if (sharedAdmission !== undefined && !await sharedAdmission(bounded)) throw new Error(UNAVAILABLE)
    return { state }
  }
}
