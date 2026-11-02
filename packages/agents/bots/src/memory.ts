/** Durable, Bot-owned memory records projected from the Bot Session log. */

import { brandString, type Branded } from '@yharness/brand'
import type { SessionEvent } from '@yharness/session'
import type { BotId } from './types.ts'

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
  /** User-authored reference text; it is quoted in the Bot system prompt. */
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
}

/** Request to delete one durable Bot memory. */
export interface BotMemoryForgetRequest {
  /** Memory identity returned by `remember_bot_memory` or `list_bot_memory`. */
  readonly memoryId: BotMemoryId
}

/** Provider-facing operations scoped to one trusted Bot Session. */
export interface BotMemoryClient {
  /** Save or idempotently replay one memory for the current Bot. */
  readonly remember: (request: BotMemoryRememberRequest) => Promise<BotMemoryRecord>
  /** List the current Bot's durable memories in creation order. */
  readonly list: () => Promise<readonly BotMemoryRecord[]>
  /** Remove one memory by its stable identity. */
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

/**
 * Reconstruct one Bot's active memory records from its Session log.
 * Invalid payloads are ignored because the Session decoder owns the durable
 * event envelope; a mismatched Bot id can never affect another Bot's prompt.
 * @param events - Events read from the Bot-owned Session.
 * @param botId - Authoritative Bot id bound to that Session.
 * @returns active memory records keyed by their stable id.
 */
export function projectBotMemories(events: readonly SessionEvent[], botId: BotId): Map<string, BotMemoryRecord> {
  const memories = new Map<string, BotMemoryRecord>()
  for (const event of events) {
    if (event.type !== 'bot/memory' || String(event.data.botId) !== String(botId)) continue
    const id = String(event.data.memoryId)
    if (!MEMORY_ID_PATTERN.test(id) || id.length > 256) continue
    if (event.data.operation === 'remember') {
      let text: string
      try {
        text = normalizeBotMemoryText(event.data.text)
      } catch {
        continue
      }
      memories.set(id, { id: BotMemoryId(id), text, createdAt: event.time })
    } else {
      memories.delete(id)
    }
  }
  return memories
}
