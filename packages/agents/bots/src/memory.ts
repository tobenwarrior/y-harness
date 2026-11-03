/** Durable, Bot-owned memory records projected from the Bot Session log. */

import { brandString, type Branded } from '@yharness/brand'
import type { SessionEvent } from '@yharness/session'
import { BotId as makeBotId, type BotId } from './types.ts'

/** Stable identity for one durable memory entry. */
export type BotMemoryId = Branded<'BotMemoryId'>

/** Apply the memory identity brand after the Host has validated the value. */
export function BotMemoryId(value: string): BotMemoryId {
  return brandString<BotMemoryId>(value)
}
/** Durable memory row projected from one remembered event. */
export interface BotMemoryRecord {
  /** Stable identity used by `forget_bot_memory`. */
  readonly id: BotMemoryId
  /** User-authored reference text included in later Bot system prompts as untrusted data. */
  readonly text: string
  /** Session-log timestamp of the remember operation. */
  readonly createdAt: number
}

/** Request to save one durable Bot memory. */
export interface BotMemoryRememberRequest {
  /** Reference text to retain for this Bot. */
  readonly text: string
  /** Optional retry identity; repeated writes with the same text are idempotent. */
  readonly memoryId?: BotMemoryId
  /** Cancellation from the model tool or provider bridge. */
  readonly signal?: AbortSignal
}

/** Request to logically delete one durable Bot memory from future projections. */
export interface BotMemoryForgetRequest {
  /** Memory identity returned by `remember_bot_memory` or `list_bot_memory`. */
  readonly memoryId: BotMemoryId
  /** Cancellation from the model tool or provider bridge. */
  readonly signal?: AbortSignal
}

/** Provider-facing operations scoped to one trusted Bot Session. */
export interface BotMemoryClient {
  /** Save or idempotently replay one memory for the current Bot. */
  readonly remember: (request: BotMemoryRememberRequest) => Promise<BotMemoryRecord>
  /** List the current Bot's durable memories in creation order. */
  readonly list: (signal?: AbortSignal) => Promise<readonly BotMemoryRecord[]>
  /** Logically remove one memory by its stable identity; append-only history remains. */
  readonly forget: (request: BotMemoryForgetRequest) => Promise<void>
}

/** Stable failure categories for a memory provider bridge. */
export type BotMemoryErrorCode =
  | 'sender-not-bot'
  | 'memory-invalid'
  | 'memory-not-found'
  | 'memory-id-conflict'
  | 'memory-limit'
  | 'cancelled'
  | 'durability-failed'

/** Error raised when one Bot memory operation cannot be admitted. */
export class BotMemoryError extends Error {
  /** @param code - Stable failure category. @param message - Safe diagnostic. @param options - Optional underlying failure. */
  constructor(readonly code: BotMemoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BotMemoryError'
  }
}

/** Required Session event for a remembered or forgotten Bot memory. */
export type BotMemoryEvent =
  | {
    readonly botId: BotId
    readonly memoryId: BotMemoryId
    readonly operation: 'remember'
    readonly text: string
  }
  | {
    readonly botId: BotId
    readonly memoryId: BotMemoryId
    readonly operation: 'forget'
  }

declare module '@yharness/session/types' {
  interface SessionEventMap {
    /** Durable Bot memory mutation; the current memory prompt is reconstructed from these events. */
    'bot/memory': BotMemoryEvent
  }
}

const MEMORY_ID_PATTERN = /^memory-[A-Za-z0-9][A-Za-z0-9-]*$/
const BOT_ID_PATTERN = /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/

/** Maximum text admitted into one model-visible memory entry. */
export const BOT_MEMORY_TEXT_LIMIT = 2_000

/** Maximum active entries included in one Bot memory projection. */
export const BOT_MEMORY_ENTRY_LIMIT = 100

/** Validate and brand a durable memory identity from a model or wire boundary. */
export function parseBotMemoryId(value: string): BotMemoryId {
  if (typeof value !== 'string' || !MEMORY_ID_PATTERN.test(value) || value.length > 256) {
    throw new BotMemoryError('memory-invalid', 'Memory ids must begin with memory- and contain simple URL-safe segments.')
  }
  return BotMemoryId(value)
}

/** Normalize and bound user-authored memory text. */
export function normalizeBotMemoryText(value: string): string {
  if (typeof value !== 'string') throw new BotMemoryError('memory-invalid', 'Memory text must be a string.')
  const text = value.trim()
  if (text.length === 0 || Array.from(text).length > BOT_MEMORY_TEXT_LIMIT) {
    throw new BotMemoryError('memory-invalid', `Memory text must contain 1-${String(BOT_MEMORY_TEXT_LIMIT)} characters.`)
  }
  return text
}

function invalidStoredMemory(message: string): BotMemoryError {
  return new BotMemoryError('durability-failed', `The Bot memory log contains an invalid Bot memory event: ${message}`)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStoredMemoryEvent(event: SessionEvent, botId: BotId): BotMemoryEvent | undefined {
  if (!record(event) || event.type !== 'bot/memory') return undefined
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw invalidStoredMemory('event sequence must be a non-negative safe integer')
  if (!Number.isSafeInteger(event.time) || event.time < 0) throw invalidStoredMemory('event time must be a non-negative safe integer')
  if (!record(event.data)) throw invalidStoredMemory('data must be an object')
  const data = event.data as Record<string, unknown>
  const operation: unknown = data['operation']
  if (Object.keys(data).some(key => !['botId', 'memoryId', 'operation', 'text'].includes(key))) {
    throw invalidStoredMemory('data contains an unknown field')
  }
  if (typeof data.botId !== 'string' || !BOT_ID_PATTERN.test(data.botId)) throw invalidStoredMemory('botId is invalid')
  if (data.botId !== String(botId)) throw invalidStoredMemory(`event belongs to Bot "${data.botId}" instead of "${String(botId)}"`)
  if (typeof data.memoryId !== 'string' || !MEMORY_ID_PATTERN.test(data.memoryId) || data.memoryId.length > 256) {
    throw invalidStoredMemory('memoryId is invalid')
  }
  if (operation === 'remember') {
    const rawText: unknown = data['text']
    if (typeof rawText !== 'string') throw invalidStoredMemory('remember events require text')
    let text: string
    try {
      text = normalizeBotMemoryText(rawText)
    } catch (error: unknown) {
      throw invalidStoredMemory(error instanceof BotMemoryError ? error.message : 'remember text is invalid')
    }
    return { botId: makeBotId(data.botId), memoryId: BotMemoryId(data.memoryId), operation: 'remember', text }
  }
  if (operation !== 'forget') throw invalidStoredMemory('operation must be remember or forget')
  if (Object.hasOwn(data, 'text')) throw invalidStoredMemory('forget events must not contain text')
  return { botId: makeBotId(data.botId), memoryId: BotMemoryId(data.memoryId), operation: 'forget' }
}

/**
 * Reconstruct one Bot's active memory records from its Session log.
 * Required Bot memory records are validated here as well as at the Session
 * envelope boundary. A malformed or foreign record refuses projection rather
 * than silently changing the Bot's reconstructed memory.
 * @param events - Events read from the Bot-owned Session.
 * @param botId - Authoritative Bot id bound to that Session.
 * @returns active memory records keyed by their stable id.
 */
export function projectBotMemories(events: readonly SessionEvent[], botId: BotId): Map<string, BotMemoryRecord> {
  return projectBotMemoryState(events, botId).memories
}

/**
 * Reconstruct active Bot memories and logical forget tombstones from a
 * Session log. Tombstones make a repeated forget idempotent after a restart.
 * @param events - Events read from the Bot-owned Session.
 * @param botId - Authoritative Bot id bound to that Session.
 * @returns active records and ids whose latest memory event is a forget.
 */
export function projectBotMemoryState(events: readonly SessionEvent[], botId: BotId): {
  readonly memories: Map<string, BotMemoryRecord>
  readonly forgotten: Set<string>
} {
  const memories = new Map<string, BotMemoryRecord>()
  const forgotten = new Set<string>()
  for (const event of events) {
    const memoryEvent = parseStoredMemoryEvent(event, botId)
    if (memoryEvent === undefined) continue
    const id = String(memoryEvent.memoryId)
    if (memoryEvent.operation === 'remember') {
      const current = memories.get(id)
      if (current !== undefined && current.text !== memoryEvent.text) {
        throw invalidStoredMemory(`memory "${id}" was remembered with conflicting text`)
      }
      if (current === undefined) memories.set(id, {
        id: memoryEvent.memoryId, text: memoryEvent.text, createdAt: event.time,
      })
      forgotten.delete(id)
    }
    else {
      memories.delete(id)
      forgotten.add(id)
    }
  }
  return { memories, forgotten }
}
