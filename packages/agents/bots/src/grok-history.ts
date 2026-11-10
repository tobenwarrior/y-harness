/** Owner-only transcript archives recovered from Grok Bot. */

import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import type {
  BotGrokHistoryArchive,
  BotGrokHistoryMessage,
  BotId,
} from './types.ts'

/** Request one bounded page from the current Bot's imported Grok archive. */
export interface BotGrokHistoryPageRequest {
  /** Maximum number of newest cached messages to return. */
  readonly limit?: number
  /** Exclusive source sequence cursor returned by an earlier page. */
  readonly before?: number
}

/** Page projected from the current Bot's imported Grok archive before tool framing. */
export interface BotGrokHistoryPage {
  readonly source: 'grok-bot'
  readonly version: 1
  /** Earliest position recovered from the source cache, which may be later than one. */
  readonly firstCachedSequence: number
  /** Number of messages retained in the archive, before page truncation. */
  readonly totalMessages: number
  /** Cursor for an older page, when the retained archive has older messages. */
  readonly nextBefore?: number
  /** Chronological excerpts from the requested page. */
  readonly messages: readonly BotGrokHistoryMessage[]
}

/** Validated page request passed from a model-facing tool to its Host adapter. */
export interface BotGrokHistoryPageResolvedRequest {
  readonly limit: number
  readonly before?: number
}

/** Maximum UTF-8 size accepted for one chat archive. */
export const GROK_HISTORY_MAX_BYTES = 512 * 1024
/** Default number of messages returned by the model-facing history reader. */
export const GROK_HISTORY_PAGE_DEFAULT_LIMIT = 5
/** Maximum number of messages returned by one model-facing history page. */
export const GROK_HISTORY_PAGE_MAX_LIMIT = 10
/** Maximum number of source characters retained in one model-facing excerpt. */
export const GROK_HISTORY_EXCERPT_MAX_CHARS = 1_000
const GROK_HISTORY_EXCERPT_SUFFIX = ' … [excerpt truncated]'

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

/**
 * Resolve a model-facing archive page request without applying hidden defaults at the reader.
 * @param request - Optional page limit and exclusive source cursor.
 * @returns A validated request with an explicit bounded limit.
 */
export function resolveGrokHistoryPageRequest(request: BotGrokHistoryPageRequest = {}): BotGrokHistoryPageResolvedRequest {
  const limit = request.limit === undefined ? GROK_HISTORY_PAGE_DEFAULT_LIMIT : request.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GROK_HISTORY_PAGE_MAX_LIMIT) {
    throw new RangeError(`limit must be a safe integer from 1 through ${GROK_HISTORY_PAGE_MAX_LIMIT}.`)
  }
  const before = request.before
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
    throw new RangeError('before must be a positive source sequence.')
  }
  return { limit, ...(before === undefined ? {} : { before }) }
}

function excerpt(text: string): string {
  if (text.length <= GROK_HISTORY_EXCERPT_MAX_CHARS) return text
  return `${text.slice(0, GROK_HISTORY_EXCERPT_MAX_CHARS - GROK_HISTORY_EXCERPT_SUFFIX.length)}${GROK_HISTORY_EXCERPT_SUFFIX}`
}

/**
 * Enforce the excerpt limit on a page returned by a Host adapter.
 * @param page - Page projected for the current Bot.
 * @returns The same page metadata with bounded message text.
 */
export function boundGrokHistoryPage(page: BotGrokHistoryPage): BotGrokHistoryPage {
  return { ...page, messages: page.messages.map(message => ({ ...message, text: excerpt(message.text) })) }
}

/**
 * Project a stored archive into one chronological page for a model-facing tool.
 * @param archive - Owner-selected archive for the current Bot.
 * @param request - Previously validated page request.
 * @returns A page with source coverage and chronological message text.
 */
export function readGrokHistoryPage(
  archive: BotGrokHistoryArchive,
  request: BotGrokHistoryPageResolvedRequest,
): BotGrokHistoryPage {
  const before = request.before
  const eligible = before === undefined
    ? archive.messages
    : archive.messages.filter(message => message.sourceSequence < before)
  const messages = eligible.slice(Math.max(eligible.length - request.limit, 0))
  const firstMessage = messages[0]
  return {
    source: archive.source,
    version: archive.version,
    firstCachedSequence: archive.firstCachedSequence,
    totalMessages: archive.messages.length,
    ...(firstMessage !== undefined && messages.length < eligible.length
      ? { nextBefore: firstMessage.sourceSequence }
      : {}),
    messages,
  }
}
