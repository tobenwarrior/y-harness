/** Owner-only transcript archives recovered from Grok Bot. */

import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import type { BotGrokHistoryArchive, BotId } from './types.ts'

/** Maximum UTF-8 size accepted for one chat archive. */
export const GROK_HISTORY_MAX_BYTES = 512 * 1024

const sequence = z.number().safe().int().positive()
const archive = z.object({
  source: z.literal('grok-bot'),
  version: z.literal(1),
  firstCachedSequence: sequence,
  messages: z.array(z.object({
    sourceSequence: sequence,
    role: z.enum(['user', 'assistant']),
    text: z.string().min(1).max(64 * 1024),
    timestampMs: z.number().safe().int().min(0).max(8_640_000_000_000_000),
  }).strict()).min(1).max(4_096),
}).strict().refine(({ firstCachedSequence, messages }) => {
  let previous = firstCachedSequence - 1
  for (const message of messages) {
    if (message.sourceSequence <= previous) return false
    previous = message.sourceSequence
  }
  return true
})

/** Display-only archives keyed by the existing owner Bot. */
export const botGrokHistoryDomain = defineDomain({
  name: 'agent_bot_grok_history',
  version: 1,
  layout: 'per-record',
  tables: {
    archives: domainTable<BotId, BotGrokHistoryArchive>(archive),
  },
})

/**
 * Decode a size-bounded versioned transcript export.
 * @param document - UTF-8 JSON from an owner-selected archive.
 * @returns A chronological archive, or undefined for invalid input.
 */
export function decodeGrokHistory(document: string): BotGrokHistoryArchive | undefined {
  if (Buffer.byteLength(document) > GROK_HISTORY_MAX_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(document)
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  return archive.safeParse(value).data
}
