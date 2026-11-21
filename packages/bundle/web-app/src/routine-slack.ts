/** Mount a Bot routine source backed by Slack Socket Mode. */

import type {} from '@yharness/bots'
import type { Context } from '@yharness/cordis'
import { credentialRef } from '@yharness/credentials'
import z from '@yharness/schemastery'
import {
  createSlackSocketTransport,
  type SlackSocketTransport,
  type SlackSocketTransportOptions,
} from './slack-socket.ts'

/** Production Slack transport factory; re-exported for local composition tests. */
export { createSlackSocketTransport } from './slack-socket.ts'

/** Stable name of the optional Slack Socket Mode ingress plugin. */
export const name = 'bot-routine-slack'

/** Services needed to resolve the app token and admit Bot routine events. */
export const inject = ['bots', 'credentials']

const DEFAULT_APP_TOKEN_ENV = 'SLACK_APP_TOKEN'
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_QUEUED = 32
const DEFAULT_MAX_PAYLOAD_BYTES = 262_144
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_SOCKET_OPEN_TIMEOUT_MS = 15_000
const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000
const DEFAULT_DISPOSE_DRAIN_TIMEOUT_MS = 10_000

/** Validated settings for one Slack installation and its bounded ingress. */
export interface Config {
  /** Local source label used by Bot routine selectors. */
  source: string
  /** Slack workspace (team) id, for example `T0123456789`. */
  workspaceId: string
  /** Slack app id, for example `A0123456789`. */
  appId: string
  /** Credential reference containing the app-level `xapp-` token. */
  appTokenEnv: string
  /** Maximum concurrently admitted Slack envelopes. */
  maxConcurrent: number
  /** Maximum envelopes queued behind active admissions. */
  maxQueued: number
  /** Maximum UTF-8 bytes accepted for one Slack WebSocket frame. */
  maxPayloadBytes: number
  /** Timeout for the official `apps.connections.open` request. */
  requestTimeoutMs: number
  /** Timeout for the Slack WebSocket handshake. */
  socketOpenTimeoutMs: number
  /** Initial delay before reconnecting after a transport failure. */
  reconnectBaseMs: number
  /** Maximum delay between reconnect attempts. */
  reconnectMaxMs: number
  /** Maximum time to drain active Bot admissions while disposing. */
  disposeDrainTimeoutMs: number
}

export const Config = z.object({
  source: z.string().min(1).max(96).pattern(/^[a-z0-9][a-z0-9._-]*$/iu).required(),
  workspaceId: z.string().pattern(/^T[0-9A-Z]{1,39}$/u).required(),
  appId: z.string().pattern(/^A[0-9A-Z]{1,39}$/u).required(),
  appTokenEnv: z.string().role('credential-ref').default(DEFAULT_APP_TOKEN_ENV),
  maxConcurrent: z.number().step(1).min(1).max(32).default(DEFAULT_MAX_CONCURRENT),
  maxQueued: z.number().step(1).min(0).max(256).default(DEFAULT_MAX_QUEUED),
  maxPayloadBytes: z.natural().min(1_024).max(1_048_576).default(DEFAULT_MAX_PAYLOAD_BYTES),
  requestTimeoutMs: z.number().step(1).min(1_000).max(60_000).default(DEFAULT_REQUEST_TIMEOUT_MS),
  socketOpenTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(DEFAULT_SOCKET_OPEN_TIMEOUT_MS),
  reconnectBaseMs: z.number().step(1).min(100).max(60_000).default(DEFAULT_RECONNECT_BASE_MS),
  reconnectMaxMs: z.number().step(1).min(1_000).max(300_000).default(DEFAULT_RECONNECT_MAX_MS),
  disposeDrainTimeoutMs: z.number().step(1).min(100).max(120_000).default(DEFAULT_DISPOSE_DRAIN_TIMEOUT_MS),
}) satisfies z<Config>

/** Factory seam used by local composition tests to supply a fake or local socket. */
export type SlackRoutineTransportFactory = (options: SlackSocketTransportOptions) => SlackSocketTransport

/**
 * Register and start one Slack routine source outside the Cordis effect wrapper.
 * @param ctx - Context with Bot and credential services.
 * @param config - Validated Slack installation and transport limits.
 * @param createTransport - Optional local transport factory for isolated tests.
 * @returns A disposer that stops the transport and retires the Bot source.
 */
export function mountSlackRoutineSource(
  ctx: Context,
  config: Config,
  createTransport: SlackRoutineTransportFactory = createSlackSocketTransport,
): () => Promise<void> {
  const appTokenRef = credentialRef(config.appTokenEnv)
  const source = ctx.bots.registerSlackRoutineSource({
    source: config.source,
    workspaceId: config.workspaceId,
    appId: config.appId,
  })
  const transport = createTransport({
    workspaceId: config.workspaceId,
    appId: config.appId,
    resolveToken: async () => (await ctx.credentials.resolve(appTokenRef))?.value,
    accept: (payload, receivedAt) => source.accept(payload, receivedAt),
    maxConcurrent: config.maxConcurrent,
    maxQueued: config.maxQueued,
    maxPayloadBytes: config.maxPayloadBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    socketOpenTimeoutMs: config.socketOpenTimeoutMs,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
    disposeDrainTimeoutMs: config.disposeDrainTimeoutMs,
    logger: ctx.logger,
  })
  void transport.start()
  return async () => {
    await transport.dispose()
    source.dispose()
  }
}

/**
 * Register one Slack Socket Mode connection and its durable Bot admission sink.
 * @param ctx - Context with Bot and credential services.
 * @param config - Validated Slack installation and transport limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => mountSlackRoutineSource(ctx, config), 'bot-routine-slack: Socket Mode ingress')
}
