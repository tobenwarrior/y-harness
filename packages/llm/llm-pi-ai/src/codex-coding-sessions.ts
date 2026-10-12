/** Read-only coding-session operations over an already connected native Codex peer. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionEvent, CodingSessionProvider, CodingSessionSnapshot, CodingSessionReadRequest, CodingSessionWriterState } from '@deepseek-ai/dsh-coding-session/types'

const codingSessionDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex')

/** Only the supported connected app-server discovery/read requests, with no launch or write access. */
export interface CodexCodingSessionReader {
  /** @returns readiness of the exact configured native peer. */
  connected(): boolean
  /** @param method - read-only native operation. @param params - provider-owned request fields. @returns parsed JSON-RPC response data. */
  request(method: 'thread/list' | 'thread/read' | 'thread/turns/list' | 'thread/items/list', params: object): Promise<unknown>
}
const status = z.object({ type: z.enum(['idle', 'active', 'notLoaded', 'systemError']) }).loose()
const item = z.object({ id: z.string().min(1), type: z.string().min(1) }).loose()
const turn = z.object({
  id: z.string().min(1), status: z.enum(['completed', 'failed', 'interrupted', 'inProgress']),
  items: z.array(item), itemsView: z.enum(['notLoaded', 'summary', 'full']).optional(),
}).loose()
const metadata = z.object({ id: z.string().min(1), name: z.string().nullable().optional(), preview: z.string(), cwd: z.string(), updatedAt: z.number(), historyMode: z.enum(['legacy', 'paginated']).default('legacy'), status, turns: z.array(turn) }).loose()
const turnPage = z.object({ data: z.array(turn), nextCursor: z.string().nullable().optional() })
const nativeItem = z.object({
  turnId: z.string().min(1), item, startedAtMs: z.number().nullable().optional(), completedAtMs: z.number().nullable().optional(),
}).loose()
const itemPage = z.object({ data: z.array(nativeItem), nextCursor: z.string().nullable().optional() })
const state = (type: string): CodingSessionWriterState => type === 'idle' ? 'idle' : type === 'active' ? 'active' : 'unknown'
const textInput = z.array(z.object({ type: z.string(), text: z.string().optional() }).loose())

/**
 * Register native history reads under one exact configured connection identity.
 * The provider has no writer: native idle status does not exclude another CLI.
 * @param profileIdentity - stable identity of the configured native home/connection.
 * @param label - user-visible connection label without credentials.
 * @param resolve - reader of the already connected peer; never starts a native process.
 * @returns a source-labelled read-only provider.
 */
export function createCodexCodingSessionProvider(
  profileIdentity: string, label: string, resolve: () => CodexCodingSessionReader | undefined,
): CodingSessionProvider {
  const profileId = brandString<CodingSessionProvider['profileId']>(profileIdentity)
  const connected = (): boolean => resolve()?.connected() === true
  const reader = (request: CodingSessionReadRequest): CodexCodingSessionReader => {
    request.signal.throwIfAborted()
    const value = resolve()
    if (value === undefined || !value.connected()) throw new Error('Native Codex coding session source is not connected. Refresh the backend first.')
    return value
  }
  return { provider: 'codex', profileId, label, connected,
    discover: async (request, cursor) => {
      const peer = reader(request)
      const parsed = z.object({ data: z.array(metadata), nextCursor: z.string().nullable().optional() }).parse(await peer.request('thread/list', { limit: request.limit, ...(cursor === undefined ? {} : { cursor }), sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true }))
      reader(request)
      return { items: parsed.data.map(value => ({ source: { provider: 'codex', profileId, nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>(value.id) }, title: value.name ?? value.preview, cwd: value.cwd, writerState: state(value.status.type) })),
        ...(parsed.nextCursor == null ? {} : { nextCursor: parsed.nextCursor }) }
    },
    read: async (nativeSessionId, request) => {
      const peer = reader(request)
      const head = z.object({ thread: metadata }).parse(await peer.request('thread/read', { threadId: nativeSessionId, includeTurns: false })).thread
      reader(request)
      if (head.id !== nativeSessionId) throw new Error('Codex did not return the original native session.')
      if (head.status.type === 'active') throw new Error('Native coding session is active. Refresh after its turn settles.')
      const verifyThread = (thread: z.infer<typeof metadata>): void => {
        reader(request)
        if (thread.id !== nativeSessionId) throw new Error('Codex did not return the original native session.')
        if (thread.historyMode !== head.historyMode) throw new Error('Native Codex changed its history mode while reading. Refresh the source before trying again.')
        if (thread.status.type === 'active' || thread.turns.some(value => value.status === 'inProgress')) {
          throw new Error('Native coding session is active. Refresh after its turn settles.')
        }
      }
      const event = (
        value: z.infer<typeof turn>, entry: z.infer<typeof item>, nativeEntry?: z.infer<typeof nativeItem>,
      ): CodingSessionEvent => {
        const role = entry.type === 'userMessage' ? 'user' : entry.type === 'agentMessage' ? 'assistant' : entry.type === 'reasoning' ? 'system' : 'tool'
        const text = role === 'user' ? textInput.parse(entry.content).map(part => part.type === 'text' ? part.text ?? '' : `[Native ${part.type} input]`).join('\n')
          : role === 'assistant' ? z.string().parse(entry.text)
            : `[Native ${entry.type} item]`
        return { id: brandString<CodingSessionEvent['id']>(JSON.stringify([value.id, entry.id])), role, text, digest: codingSessionDigest({ status: value.status, item: entry, ...(nativeEntry === undefined ? {} : { nativeEntry }) }) }
      }
      const snapshot = (
        thread: z.infer<typeof metadata>, turns: Array<{ id: string; status: string }>, events: CodingSessionEvent[],
      ): CodingSessionSnapshot => ({
        source: { provider: 'codex', profileId, nativeSessionId }, title: thread.name ?? thread.preview, cwd: thread.cwd, writerState: state(thread.status.type), events,
        cursor: codingSessionDigest({ updatedAt: thread.updatedAt, turns, events: events.map(value => [value.id, value.digest]) }),
      })
      const paginatedRead = async (): Promise<CodingSessionSnapshot> => {
        const events: CodingSessionEvent[] = []; const turns: Array<{ id: string; status: string }> = []
        const turnIds = new Set<string>(); const turnCursors = new Set<string>()
        let bytes = 0; let turnPages = 0; let cursor: string | undefined
        const bound = (value: unknown): void => {
          bytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
          if (bytes > request.maxBytes) throw new Error('Native coding session history exceeded the configured byte limit.')
        }
        do {
          request.signal.throwIfAborted()
          if (++turnPages > request.maxEvents) throw new Error('Native coding session turn pagination exceeded the configured limit.')
          const page = turnPage.parse(await peer.request('thread/turns/list', { threadId: nativeSessionId, limit: request.limit, sortDirection: 'asc', itemsView: 'notLoaded', ...(cursor === undefined ? {} : { cursor }) }))
          reader(request); bound(page)
          if (page.data.length > request.limit || turns.length + page.data.length > request.maxEvents) throw new Error('Native coding session turn list exceeded the configured limit.')
          for (const value of page.data) {
            if (value.status === 'inProgress') throw new Error('Native coding session is active. Refresh after its turn settles.')
            if (turnIds.has(value.id)) throw new Error('Native coding session pagination repeated a turn identity.')
            turnIds.add(value.id); turns.push({ id: value.id, status: value.status })
            const itemCursors = new Set<string>(); let itemPages = 0; let itemCursor: string | undefined
            do {
              request.signal.throwIfAborted()
              if (++itemPages > request.maxEvents) throw new Error('Native coding session item pagination exceeded the configured limit.')
              const entries = itemPage.parse(await peer.request('thread/items/list', { threadId: nativeSessionId, turnId: value.id, limit: request.limit, sortDirection: 'asc', ...(itemCursor === undefined ? {} : { cursor: itemCursor }) }))
              reader(request); bound(entries)
              if (entries.data.length > request.limit || events.length + entries.data.length > request.maxEvents) throw new Error('Native coding session history exceeded the configured event limit.')
              for (const entry of entries.data) {
                if (entry.turnId !== value.id) throw new Error('Codex returned an item outside the original native turn.')
                events.push(event(value, entry.item, entry))
              }
              itemCursor = entries.nextCursor ?? undefined
              if (itemCursor !== undefined) {
                if (itemCursors.has(itemCursor)) throw new Error('Native coding session pagination repeated an item cursor.')
                itemCursors.add(itemCursor)
              }
            } while (itemCursor !== undefined)
          }
          cursor = page.nextCursor ?? undefined
          if (cursor !== undefined) {
            if (turnCursors.has(cursor)) throw new Error('Native coding session pagination repeated a turn cursor.')
            turnCursors.add(cursor)
          }
        } while (cursor !== undefined)
        // Metadata-only reads avoid native loaded-paginated full-history persistence.
        const thread = z.object({ thread: metadata }).parse(await peer.request('thread/read', { threadId: nativeSessionId, includeTurns: false })).thread
        verifyThread(thread); bound(thread)
        return snapshot(thread, turns, events)
      }
      const read = async () => {
        if (head.historyMode === 'paginated') return paginatedRead()
        request.signal.throwIfAborted()
        const { thread } = z.object({ thread: metadata }).parse(await peer.request('thread/read', { threadId: nativeSessionId, includeTurns: true }))
        verifyThread(thread)
        if (thread.turns.some(value => value.itemsView !== undefined && value.itemsView !== 'full')) throw new Error('Codex did not return complete native history. This native history mode is unavailable for import.')
        if (Buffer.byteLength(JSON.stringify(thread), 'utf8') > request.maxBytes) throw new Error('Native coding session history exceeded the configured byte limit.')
        const events = thread.turns.flatMap(value => value.items.map(entry => event(value, entry)))
        if (events.length > request.maxEvents) throw new Error('Native coding session history exceeded the configured event limit.')
        return snapshot(thread, thread.turns.map(value => ({ id: value.id, status: value.status })), events)
      }
      const first = await read(); const second = await read()
      if (codingSessionDigest(first) !== codingSessionDigest(second)) throw new Error('Native coding session changed while reading. Retry after its writer is idle.')
      return second
    },
  }
}
