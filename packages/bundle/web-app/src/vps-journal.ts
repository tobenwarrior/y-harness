/** Read-only owner-filtered journal access for managed VPS Bots. */

import { createConnection } from 'node:net'
import { readVpsSocketReply } from './vps-socket-reply.ts'
import { isAbsolute } from 'node:path'
import type { Context } from '@yharness/cordis'
import { ToolArgsError, validateJsonSchemaValue } from '@yharness/tools'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_BYTES = 256 * 1024
const DEFAULT_MAX_ENTRIES = 256
const MAX_JSON_DEPTH = 8
const MAX_JSON_KEYS = 128
const MAX_JSON_ARRAY_LENGTH = 256
const MAX_JSON_STRING_BYTES = 16 * 1024
const MAX_VERSION = 2 ** 31 - 1

const UNAUTHORIZED = 'This Bot is not authorized for the VPS journal.'
const ABORTED = 'VPS journal request was cancelled.'
const TIMED_OUT = 'VPS journal request timed out.'
const UNAVAILABLE = 'VPS journal is unavailable.'
const INVALID = 'VPS journal response is invalid.'

/** Trusted owner configuration for one read-only VPS journal socket. */
export interface VpsJournalConfig {
  /** Absolute Unix-domain socket path owned by the VPS journal service. */
  readonly socketPath: string
  /** Bot roster ids allowed to read this journal. */
  readonly bots: string[]
  /** Maximum wall-clock time for one socket read. Defaults to five seconds. */
  readonly timeoutMs?: number
  /** Maximum response frame size in bytes. Defaults to 256 KiB. */
  readonly maxBytes?: number
  /** Maximum entries retained in each response array. Defaults to 256. */
  readonly maxEntries?: number
}

/** JSON values retained inside one filtered journal entry. */
export type VpsJournalValue = null | boolean | number | string | readonly VpsJournalValue[] | {
  readonly [key: string]: VpsJournalValue
}

/** One filtered journal entry with bounded, JSON-compatible fields. */
export interface VpsJournalEntry {
  readonly [key: string]: VpsJournalValue
}

/** One complete bounded response from the VPS journal socket. */
export interface VpsJournalSnapshot {
  readonly version: number
  readonly generatedAt: string
  readonly recovery: readonly VpsJournalEntry[]
  readonly primaryAudit: readonly VpsJournalEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_JSON_STRING_BYTES
}

function boundedJson(value: unknown, depth: number): VpsJournalValue | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return boundedString(value) ? value : undefined
  if (depth >= MAX_JSON_DEPTH) return undefined
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_LENGTH) return undefined
    const result: VpsJournalValue[] = []
    for (const child of value) {
      const bounded = boundedJson(child, depth + 1)
      if (bounded === undefined) return undefined
      result.push(bounded)
    }
    return Object.freeze(result)
  }
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length > MAX_JSON_KEYS) return undefined
  const result: Record<string, VpsJournalValue> = Object.create(null) as Record<string, VpsJournalValue>
  for (const key of keys) {
    if (Buffer.byteLength(key, 'utf8') > MAX_JSON_STRING_BYTES) return undefined
    const bounded = boundedJson(value[key], depth + 1)
    if (bounded === undefined) return undefined
    result[key] = bounded
  }
  return Object.freeze(result)
}

function boundedEntries(value: unknown, maxEntries: number): readonly VpsJournalEntry[] | undefined {
  if (!Array.isArray(value) || value.length > maxEntries) return undefined
  const entries: VpsJournalEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const bounded = boundedJson(item, 0)
    if (bounded === undefined || !isRecord(bounded)) return undefined
    entries.push(bounded)
  }
  return Object.freeze(entries)
}

function decode(serialized: Buffer, maxEntries: number): VpsJournalSnapshot {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(serialized))
  } catch {
    throw new Error(INVALID)
  }
  if (!isRecord(value)
    || !boundedInteger(value.version, MAX_VERSION)
    || !boundedString(value.generatedAt)) {
    throw new Error(INVALID)
  }
  const recovery = boundedEntries(value.recovery, maxEntries)
  const primaryAudit = boundedEntries(value.primaryAudit, maxEntries)
  if (recovery === undefined || primaryAudit === undefined) throw new Error(INVALID)
  return Object.freeze({
    version: value.version,
    generatedAt: value.generatedAt,
    recovery,
    primaryAudit,
  })
}

function safeFailure(error: unknown): Error {
  if (error instanceof Error && error.message === INVALID) return error
  return new Error(UNAVAILABLE)
}

function validateConfig(config: VpsJournalConfig): { timeoutMs: number; maxBytes: number; maxEntries: number } {
  if (!isAbsolute(config.socketPath) || config.socketPath.includes('\u0000')) {
    throw new TypeError('VPS journal socketPath must be absolute.')
  }
  if (config.bots.length === 0 || config.bots.some(bot => typeof bot !== 'string' || bot.length === 0 || bot.includes('\u0000'))) {
    throw new TypeError('VPS journal bots must contain at least one valid Bot id.')
  }
  if (new Set(config.bots).size !== config.bots.length) throw new TypeError('VPS journal bots must be unique.')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('VPS journal timeoutMs is invalid.')
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
    throw new TypeError('VPS journal maxBytes is invalid.')
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > DEFAULT_MAX_ENTRIES) {
    throw new TypeError('VPS journal maxEntries is invalid.')
  }
  return { timeoutMs, maxBytes, maxEntries }
}

/** Read-only owner-filtered access to one trusted Unix-domain journal socket. */
export class VpsJournal {
  private readonly socketPath: string
  private readonly bots: ReadonlySet<string>
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly maxEntries: number

  /**
   * @param config - Trusted deployment configuration; model input never selects these values.
   */
  constructor(config: VpsJournalConfig) {
    const bounds = validateConfig(config)
    this.socketPath = config.socketPath
    this.bots = new Set(config.bots)
    this.timeoutMs = bounds.timeoutMs
    this.maxBytes = bounds.maxBytes
    this.maxEntries = bounds.maxEntries
  }

  /**
   * Return whether the configured owner allowlist admits one Bot.
   * @param bot - Bot roster id supplied by the owner-scoped registration.
   * @returns whether the Bot may read this journal.
   */
  authorized(bot: string): boolean {
    return this.bots.has(bot)
  }

  /**
   * Read one bounded response without sending any bytes to the socket.
   * @param bot - Bot roster id used for the owner allowlist check.
   * @param signal - Calling turn cancellation signal.
   * @returns The validated filtered journal snapshot.
   * @throws A fixed safe error for authorization, cancellation, timeout, socket, or protocol failures.
   */
  async read(bot: string, signal: AbortSignal): Promise<VpsJournalSnapshot> {
    if (!this.authorized(bot)) throw new Error(UNAUTHORIZED)
    const reply = await readVpsSocketReply({
      path: this.socketPath,
      maxBytes: this.maxBytes,
      timeoutMs: this.timeoutMs,
      connect: createConnection,
      errors: { aborted: ABORTED, timedOut: TIMED_OUT, unavailable: UNAVAILABLE, invalid: INVALID },
      safeFailure,
    }, signal)
    try {
      return decode(Buffer.concat(reply), this.maxEntries)
    } catch (error) {
      throw safeFailure(error)
    }
  }
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
} as const

const EMPTY_INPUT = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const

/**
 * Register the exact owner-scoped VPS journal tool for one Bot.
 * @param ctx - Context that owns the tool registration lifetime.
 * @param bot - Bot roster id admitted by the trusted journal configuration.
 * @param ownerSessionId - Session id that must own every execution.
 * @param journal - Read-only journal client used after identity checks pass.
 * @param ownerContext - Exact Agent context required for execution; defaults to `ctx`.
 * @param lifetime - Optional cancellation of the Web configuration supplying the journal.
 */
export function registerVpsJournalTool(
  ctx: Context,
  bot: string,
  ownerSessionId: string,
  journal: VpsJournal,
  ownerContext: Context = ctx,
  lifetime?: AbortSignal,
): void {
  if (!journal.authorized(bot)) return
  ctx.effect(() => ctx.tools.register({
    name: 'vps_service_journal',
    description: 'Read the bounded filtered recovery and primary-audit journal for this VPS Bot.',
    parameters: EMPTY_INPUT,
    output: TEXT_OUTPUT,
    execute: async (args, call) => {
      const agent = call.agent
      if (agent === undefined || agent.id !== ownerSessionId || agent.ctx !== ownerContext) {
        throw new Error('VPS journal requires the owning Bot Session.')
      }
      const violations = validateJsonSchemaValue(EMPTY_INPUT, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      const signal = lifetime === undefined ? call.signal : AbortSignal.any([call.signal, lifetime])
      signal.throwIfAborted()
      return JSON.stringify(await journal.read(bot, signal))
    },
  }), 'vps-journal: read-only diagnostics')
}
