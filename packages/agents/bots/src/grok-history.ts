/** Owner-only transcript archives recovered from Grok Bot. */

import { defineDomain, domainTable } from '@yharness/storage-domain'
import type { JsonValue } from '@yharness/util-values'
import { z } from 'zod'
import type {
  BotGrokHistoryArchive,
  BotGrokHistoryMessage,
  BotId,
} from './types.ts'
import { frameUntrustedTranscript } from './collaboration.ts'

/** Request one bounded page from the current Bot's imported Grok archive. */
export interface BotGrokHistoryPageRequest {
  /** Maximum number of newest cached messages to return. */
  readonly limit?: number
  /** Exclusive source sequence cursor returned by an earlier page. */
  readonly before?: number
  /** Supplemental source id, or the primary source when omitted. */
  readonly source?: string
}

/** Page projected from the current Bot's imported Grok archive before tool framing. */
export interface BotGrokHistoryPage {
  readonly source: 'grok-bot'
  readonly version: 1 | 2
  /** Selected source id when a supplemental source was requested. */
  readonly sourceId?: string
  /** Selected source label when a supplemental source was requested. */
  readonly sourceLabel?: string
  /** Whether the selected source export was marked incomplete. */
  readonly complete?: false
  /** Supplemental sources available in this version-two archive. */
  readonly sources?: BotGrokHistorySourceInfo[]
  /** Earliest position recovered from the source cache, which may be later than one. */
  readonly firstCachedSequence: number
  /** Number of messages retained in the archive, before page truncation. */
  readonly totalMessages: number
  /** Cursor for an older page, when the retained archive has older messages. */
  readonly nextBefore?: number
  /** Chronological excerpts from the requested page. */
  readonly messages: readonly BotGrokHistoryMessage[]
}

/** Metadata for a supplemental source available in a version-two archive. */
export interface BotGrokHistorySourceInfo {
  /** Stable source identifier used by a later page request. */
  readonly id: string
  /** Human-readable source label. */
  readonly label: string
}

/** Validated page request passed from a model-facing tool to its Host adapter. */
export interface BotGrokHistoryPageResolvedRequest {
  readonly limit: number
  readonly before?: number
  readonly source?: string
}

/** Maximum UTF-8 size accepted for a version-one chat archive. */
export const GROK_HISTORY_V1_MAX_BYTES = 512 * 1024
/** Maximum UTF-8 size accepted for a version-two chat archive. */
export const GROK_HISTORY_MAX_BYTES = 2 * 1024 * 1024
/** Maximum messages retained in one source list. */
export const GROK_HISTORY_MAX_MESSAGES = 4_096
/** Maximum supplemental source lists retained in one archive. */
export const GROK_HISTORY_MAX_SOURCES = 16
/** Default number of messages returned by the model-facing history reader. */
export const GROK_HISTORY_PAGE_DEFAULT_LIMIT = 5
/** Maximum number of messages returned by one model-facing history page. */
export const GROK_HISTORY_PAGE_MAX_LIMIT = 10
/** Maximum number of source characters retained in one model-facing excerpt. */
export const GROK_HISTORY_EXCERPT_MAX_CHARS = 1_000
const GROK_HISTORY_EXCERPT_SUFFIX = ' … [excerpt truncated]'

const timestamp = z.number().safe().int().min(0).max(8_640_000_000_000_000)
const v1Sequence = z.number().safe().int().positive()
const v2Sequence = z.number().safe().int().nonnegative()
const v1Message = z.object({
  sourceSequence: v1Sequence,
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(64 * 1024),
  timestampMs: timestamp,
}).strict()
const v1Archive = z.object({
  source: z.literal('grok-bot'),
  version: z.literal(1),
  firstCachedSequence: v1Sequence,
  messages: z.array(v1Message).min(1).max(GROK_HISTORY_MAX_MESSAGES),
}).strict().refine(({ firstCachedSequence, messages }) => {
  let previous = firstCachedSequence - 1
  for (const message of messages) {
    if (message.sourceSequence <= previous) return false
    previous = message.sourceSequence
  }
  return true
})

const v2Role = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).refine(value => value.trim() === value)
const v2Message = z.object({
  sourceSequence: v2Sequence,
  role: v2Role,
  text: z.string().max(64 * 1024),
  timestampMs: timestamp.nullable(),
  author: z.string().min(1).max(256).exactOptional(),
  fromBot: z.string().min(1).max(256).exactOptional(),
  incomplete: z.literal(true).exactOptional(),
}).strict().refine(({ text, incomplete }) => text.length > 0 || incomplete === true)

const v2Source = z.object({
  id: z.string().min(1).max(128).regex(/^\S(?:.*\S)?$/).refine(value => value.trim() === value),
  label: z.string().min(1).max(256),
  firstCachedSequence: v2Sequence,
  messages: z.array(v2Message).min(1).max(GROK_HISTORY_MAX_MESSAGES),
  complete: z.literal(false).exactOptional(),
}).strict().refine(({ id }) => id !== 'primary')

const v2Archive = z.object({
  source: z.literal('grok-bot'),
  version: z.literal(2),
  firstCachedSequence: v2Sequence,
  messages: z.array(v2Message).min(1).max(GROK_HISTORY_MAX_MESSAGES),
  complete: z.literal(false).exactOptional(),
  sources: z.array(v2Source).max(GROK_HISTORY_MAX_SOURCES).exactOptional(),
}).strict().superRefine(({ firstCachedSequence, messages, sources }, context) => {
  let previous = firstCachedSequence - 1
  for (const [index, message] of messages.entries()) {
    if (message.sourceSequence <= previous) {
      context.addIssue({ code: 'custom', path: ['messages', index, 'sourceSequence'], message: 'source sequences must increase' })
    }
    previous = message.sourceSequence
  }
  const ids = new Set<string>()
  for (const [index, source] of (sources ?? []).entries()) {
    if (ids.has(source.id)) {
      context.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: 'source ids must be unique' })
    }
    ids.add(source.id)
    let sourcePrevious = source.firstCachedSequence - 1
    for (const [messageIndex, message] of source.messages.entries()) {
      if (message.sourceSequence <= sourcePrevious) {
        context.addIssue({
          code: 'custom', path: ['sources', index, 'messages', messageIndex, 'sourceSequence'],
          message: 'source sequences must increase',
        })
      }
      sourcePrevious = message.sourceSequence
    }
  }
})

const archive = z.union([v1Archive, v2Archive])

/** Display-only archives keyed by the existing owner Bot. */
export const botGrokHistoryDomain = defineDomain({
  name: 'agent_bot_grok_history',
  version: 2,
  compatibleVersions: [1],
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
  const bytes = Buffer.byteLength(document)
  if (bytes > GROK_HISTORY_MAX_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(document)
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  const version = value !== null && typeof value === 'object' && 'version' in value
    ? value.version
    : undefined
  if (version === 1 && bytes > GROK_HISTORY_V1_MAX_BYTES) return undefined
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
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
    throw new RangeError('before must be a non-negative source sequence.')
  }
  const source = request.source
  if (source !== undefined && (!/^\S(?:.*\S)?$/.test(source) || source.length > 128 || source === 'primary')) {
    throw new RangeError('source must be a non-primary source id.')
  }
  return {
    limit,
    ...(before === undefined ? {} : { before }),
    ...(source === undefined ? {} : { source }),
  }
}

function excerpt(text: string): string {
  if (text.length <= GROK_HISTORY_EXCERPT_MAX_CHARS) return text
  return `${text.slice(0, GROK_HISTORY_EXCERPT_MAX_CHARS - GROK_HISTORY_EXCERPT_SUFFIX.length)}${GROK_HISTORY_EXCERPT_SUFFIX}`
}

/**
 * Frame recovered transcript data before exposing it to a model-facing tool.
 * @param page - Page projected for the current Bot.
 * @returns A JSON-safe page with bounded untrusted transcript fields.
 */
export function frameGrokHistoryPage(page: BotGrokHistoryPage): JsonValue {
  const { source, version, sourceId, sourceLabel, complete, sources, firstCachedSequence, totalMessages, nextBefore, messages } = page
  return {
    source,
    version,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(sourceLabel === undefined ? {} : { sourceLabel: frameUntrustedTranscript(excerpt(sourceLabel)) }),
    ...(complete === undefined ? {} : { complete }),
    ...(sources === undefined ? {} : {
      sources: sources.map(candidate => ({
        id: candidate.id,
        label: frameUntrustedTranscript(excerpt(candidate.label)),
      })),
    }),
    firstCachedSequence,
    totalMessages,
    ...(nextBefore === undefined ? {} : { nextBefore }),
    messages: messages.map(message => ({
      sourceSequence: message.sourceSequence,
      role: message.role,
      text: frameUntrustedTranscript(excerpt(message.text)),
      ...(message.author === undefined ? {} : { author: frameUntrustedTranscript(excerpt(message.author)) }),
      ...(message.fromBot === undefined ? {} : { fromBot: frameUntrustedTranscript(excerpt(message.fromBot)) }),
      timestampMs: message.timestampMs,
      ...(message.incomplete === undefined ? {} : { incomplete: message.incomplete }),
    })),
  }
}

function selectedSource(
  archive: BotGrokHistoryArchive,
  sourceId: string | undefined,
): {
  readonly firstCachedSequence: number
  readonly messages: readonly BotGrokHistoryMessage[]
  readonly label?: string
  readonly complete?: false
  readonly sourceId?: string
} {
  if (sourceId === undefined) {
    return {
      firstCachedSequence: archive.firstCachedSequence,
      messages: archive.messages,
      ...(archive.complete === false ? { complete: false as const } : {}),
    }
  }
  if (archive.version !== 2) throw new RangeError(`source ${JSON.stringify(sourceId)} is unavailable in a version-one archive.`)
  const source = archive.sources?.find(candidate => candidate.id === sourceId)
  if (source === undefined) throw new RangeError(`source ${JSON.stringify(sourceId)} was not found in the archive.`)
  return {
    sourceId: source.id,
    label: source.label,
    firstCachedSequence: source.firstCachedSequence,
    messages: source.messages,
    ...(source.complete === false ? { complete: false as const } : {}),
  }
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
  const selected = selectedSource(archive, request.source)
  const before = request.before
  const eligible = before === undefined
    ? selected.messages
    : selected.messages.filter(message => message.sourceSequence < before)
  const messages = eligible.slice(Math.max(eligible.length - request.limit, 0))
  const firstMessage = messages[0]
  return {
    source: archive.source,
    version: archive.version,
    ...(selected.sourceId === undefined ? {} : { sourceId: selected.sourceId, sourceLabel: selected.label }),
    ...(selected.complete === false ? { complete: false as const } : {}),
    ...(archive.version === 2 && archive.sources !== undefined && archive.sources.length > 0
      ? { sources: archive.sources.map(source => ({ id: source.id, label: source.label })) }
      : {}),
    firstCachedSequence: selected.firstCachedSequence,
    totalMessages: selected.messages.length,
    ...(firstMessage !== undefined && messages.length < eligible.length
      ? { nextBefore: firstMessage.sourceSequence }
      : {}),
    messages,
  }
}

function messageConflict(message: BotGrokHistoryMessage, incoming: BotGrokHistoryMessage): boolean {
  if (message.role !== incoming.role || message.text !== incoming.text) return true
  if (message.timestampMs !== null && message.timestampMs !== incoming.timestampMs) return true
  for (const key of ['author', 'fromBot', 'incomplete'] as const) {
    const value = message[key]
    if (value !== undefined && incoming[key] !== value) return true
  }
  return false
}

function validateSourceSuperset(
  current: { readonly firstCachedSequence: number; readonly messages: readonly BotGrokHistoryMessage[] },
  incoming: { readonly firstCachedSequence: number; readonly messages: readonly BotGrokHistoryMessage[] },
): void {
  if (incoming.firstCachedSequence > current.firstCachedSequence) throw new Error('Grok history source coverage conflict')
  const incomingBySequence = new Map(incoming.messages.map(message => [message.sourceSequence, message]))
  for (const message of current.messages) {
    const replacement = incomingBySequence.get(message.sourceSequence)
    if (replacement === undefined || messageConflict(message, replacement)) throw new Error('Grok history message conflict')
  }
}

/**
 * Merge an owner-provided archive without replacing already recovered facts.
 * @param current - Existing durable archive, if any.
 * @param incoming - Newly reviewed archive.
 * @returns The additive archive to persist.
 */
export function mergeGrokHistoryArchives(
  current: BotGrokHistoryArchive,
  incoming: BotGrokHistoryArchive,
): BotGrokHistoryArchive {
  if (current.version === 2 && incoming.version !== 2) throw new Error('Grok history archive version cannot be downgraded')
  validateSourceSuperset(current, incoming)
  if (current.complete === false && incoming.complete !== false) throw new Error('Grok history completeness marker was removed')
  const currentSources = current.version === 2 ? current.sources ?? [] : []
  const incomingSources = incoming.version === 2 ? incoming.sources ?? [] : []
  const incomingById = new Map(incomingSources.map(source => [source.id, source]))
  for (const source of currentSources) {
    const replacement = incomingById.get(source.id)
    if (replacement === undefined || replacement.label !== source.label) throw new Error('Grok history supplemental source changed')
    validateSourceSuperset(source, replacement)
    if (source.complete === false && replacement.complete !== false) throw new Error('Grok history source completeness marker was removed')
  }
  return incoming
}

/**
 * Count every primary and supplemental message in an archive.
 * @param archive - Validated archive whose stored records should be counted.
 * @returns The number of stored records across every source list.
 */
export function grokHistoryMessageCount(archive: BotGrokHistoryArchive): number {
  const supplemental = archive.version === 2 ? archive.sources ?? [] : []
  return archive.messages.length + supplemental.reduce((count, source) => count + source.messages.length, 0)
}
