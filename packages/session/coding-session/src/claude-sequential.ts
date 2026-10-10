/** Separate original-ID Claude conversation handoff, with isolated native-history readback. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClaudeSequentialExecutor, ClaudeSequentialTurnReceipt } from '@deepseek-ai/dsh-subagent-claude-code'
import { codingSessionDigest } from './digest.ts'
import type { CodingSessionProvider, CodingSessionReadRequest, CodingSessionSnapshot, CodingSessionSource,
  CodingSessionNativeTurnId, CodingSessionSequentialWriterProvider, CodingSessionSequentialWriterLease, CodingSessionSequentialReleaseReceipt } from './types.ts'

/** Complete public native message fields used to compare owned API bodies with persisted records. */
export interface ClaudeSequentialHistoryMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  session_id: string
  message: unknown
  parent_tool_use_id: string | null
  parent_agent_id: string | null
}
/** Fresh processes own every snapshot and raw-history read; no parent SDK profile state is consulted. */
export interface ClaudeSequentialReader {
  /** @param source - original identity. @param request - bounded read. @returns a complete stable native snapshot. */
  snapshot(source: CodingSessionSource, request: CodingSessionReadRequest): Promise<CodingSessionSnapshot>
  /**
   * @param source - original identity.
   * @param request - bounded read.
   * @returns all raw public native messages from new isolated readers.
   */
  messages(source: CodingSessionSource, request: CodingSessionReadRequest): Promise<ClaudeSequentialHistoryMessage[]>
  /**
   * @param source - retained original identity.
   * @param request - independent release deadline.
   * @returns full history after public source removal, while captured release authority remains held.
   */
  releaseSnapshot?(source: CodingSessionSource, request: CodingSessionReadRequest): Promise<CodingSessionSnapshot>
  /**
   * @param source - retained original identity.
   * @param request - independent release deadline.
   * @returns complete raw readback for a healthy pending receipt after source removal.
   */
  releaseMessages?(source: CodingSessionSource, request: CodingSessionReadRequest): Promise<ClaudeSequentialHistoryMessage[]>
}
/** Sequential source owner remains held when native settlement or release evidence is uncertain. */
export interface ClaudeSequentialWriterOwner {
  writer: CodingSessionSequentialWriterProvider
  /** @returns after admitted native work has stopped; retained failure remains a rejected release. */
  close(): Promise<void>
}
const sameSource = (left: CodingSessionSource, right: CodingSessionSource) => codingSessionDigest(left) === codingSessionDigest(right)
const sameSnapshot = (left: CodingSessionSnapshot, right: CodingSessionSnapshot) => codingSessionDigest(left) === codingSessionDigest(right)
const prefix = (before: CodingSessionSnapshot, after: CodingSessionSnapshot) => sameSource(before.source, after.source)
  && after.events.length >= before.events.length
  && before.events.every((event, index) => codingSessionDigest(event) === codingSessionDigest(after.events[index]))

/**
 * Validate exact public readback after an independently completed native turn.
 * @param before - complete retained source prefix before dispatch.
 * @param after - complete stable snapshot after natural process exit.
 * @param messages - complete raw public records from a fresh isolated reader.
 * @param receipt - exact dispatched user UUID/body and observed completed assistant UUID/bodies.
 * @returns after every expected record is persisted under the original identity; divergence rejects.
 */
export function validateClaudeSequentialReadback(
  before: CodingSessionSnapshot, after: CodingSessionSnapshot,
  messages: ClaudeSequentialHistoryMessage[], receipt: ClaudeSequentialTurnReceipt,
): void {
  if (!prefix(before, after) || messages.length !== after.events.length
    || new Set(messages.map(message => message.uuid)).size !== messages.length
    || messages.some((message, index) => {
      const event = after.events[index]
      return event === undefined || message.session_id !== before.source.nativeSessionId || message.uuid !== event.id
        || message.type !== event.role || codingSessionDigest({
        type: message.type, uuid: message.uuid, session_id: message.session_id, message: message.message,
        parent_tool_use_id: message.parent_tool_use_id, parent_agent_id: message.parent_agent_id,
      }) !== event.digest
    })) throw new Error('Claude sequential original native history diverged before release.')
  const appended = messages.slice(before.events.length)
  const expected = [{ type: 'user', id: receipt.nativeTurnId, message: receipt.userMessage },
    ...receipt.assistants.map(message => ({ type: 'assistant', ...message }))]
  const actual = appended.filter(message => message.type === 'user' || message.type === 'assistant')
  if (expected.length !== actual.length || expected.some((message, index) => {
    const persisted = actual[index]
    return persisted === undefined || persisted.type !== message.type || persisted.uuid !== message.id
      || persisted.parent_tool_use_id !== null || persisted.parent_agent_id !== null
      || codingSessionDigest(persisted.message) !== codingSessionDigest(message.message)
  })) throw new Error('Claude sequential completed native turn was not persisted exactly in the original conversation.')
}

/**
 * Supply the separate acknowledged-sequential writer; it never claims native all-process exclusion.
 * @param provider - configured original source identity and connection readiness.
 * @param reader - fresh isolated metadata/history reads.
 * @param executorFor - captures the exact current live Y root and starts no query at acquisition.
 * @returns an opted-in conversation-only provider and its awaited disposal.
 */
export function createClaudeSequentialWriter(
  provider: Pick<CodingSessionProvider, 'provider' | 'profileId' | 'connected'>, reader: ClaudeSequentialReader,
  executorFor: (
    source: CodingSessionSource, request: CodingSessionReadRequest,
  ) => ClaudeSequentialExecutor | Promise<ClaudeSequentialExecutor>,
): ClaudeSequentialWriterOwner {
  let closed = false; let held = false
  const leases = new Set<{ executor: ClaudeSequentialExecutor; lease: CodingSessionSequentialWriterLease }>()
  const writer: CodingSessionSequentialWriterProvider = {
    authority: 'user-acknowledged-sequential', toolMode: 'conversation',
    acquire: async (source, request) => {
      if (closed || held || !provider.connected() || source.provider !== 'claude' || source.provider !== provider.provider || source.profileId !== provider.profileId) throw new Error('Claude sequential source is not available for another owner.')
      request.signal.throwIfAborted(); held = true
      let executor: ClaudeSequentialExecutor | undefined
      try {
        executor = await executorFor(source, request)
        const captured = executor
        let expected = await reader.snapshot(source, request)
        if (!sameSource(source, expected.source) || !captured.current()) throw new Error('Claude sequential source or initiating root changed during acquisition.')
        let failure: Error | undefined; let pending = false; let released = false
        let pendingVerification: { before: CodingSessionSnapshot; receipt: ClaudeSequentialTurnReceipt } | undefined
        const turns: ClaudeSequentialTurnReceipt[] = []
        let releaseReceipt: CodingSessionSequentialReleaseReceipt | undefined
        const fresh = async (read: CodingSessionReadRequest, release = false): Promise<CodingSessionSnapshot> => {
          const value = release && reader.releaseSnapshot !== undefined
            ? await reader.releaseSnapshot(source, read) : await reader.snapshot(source, read)
          if (!sameSource(source, value.source)) throw new Error('Claude sequential reader returned a different original source.')
          return value
        }
        const verify = async (
          before: CodingSessionSnapshot, receipt: ClaudeSequentialTurnReceipt,
          read: CodingSessionReadRequest, release = false,
        ): Promise<CodingSessionSnapshot> => {
          const after = await fresh(read, release)
          const messages = release && reader.releaseMessages !== undefined
            ? await reader.releaseMessages(source, read) : await reader.messages(source, read)
          const confirmed = await fresh(read, release)
          if (!sameSnapshot(after, confirmed)) throw new Error('Claude sequential persisted readback changed during verification.')
          validateClaudeSequentialReadback(before, confirmed, messages, receipt)
          return confirmed
        }
        const lease: CodingSessionSequentialWriterLease = {
          source,
          read: async (read) => {
            if (released || failure !== undefined || pendingVerification !== undefined || !captured.current()) throw new Error('Claude sequential ownership is no longer current.')
            const value = await fresh(read)
            if (!sameSnapshot(expected, value)) throw new Error('Claude sequential source changed outside its owned turn. Refresh before claiming again.')
            return value
          },
          resumeOriginal: async (turn) => {
            if (released || pending || pendingVerification !== undefined || failure !== undefined || !sameSource(source, turn.source) || !captured.current()) throw new Error('Claude sequential turn lacks its original live owner.')
            pending = true
            const read = { ...request, signal: turn.signal }
            try {
              const before = await fresh(read)
              if (!sameSnapshot(expected, before)) throw new Error('Claude sequential native history changed before dispatch.')
              const dispatch = { started: false, recorded: false }
              const receipt = await captured.turn(turn.text, turn.signal, async () => {
                if (dispatch.started) throw new Error('Claude sequential native dispatch was recorded more than once.')
                dispatch.started = true
                const atDispatch = await fresh(read)
                if (!sameSnapshot(before, atDispatch) || !captured.current()) throw new Error('Claude sequential source changed during native preparation.')
                await turn.beforeDispatch(); dispatch.recorded = true
              })
              if (!dispatch.recorded) throw new Error('Claude sequential native completion omitted its durable dispatch record.')
              pendingVerification = { before, receipt }
              const confirmed = await verify(before, receipt, read)
              turns.push(receipt); expected = confirmed; pendingVerification = undefined
              await turn.onNativeTurn?.(receipt.nativeTurnId)
              return { nativeTurnId: brandString<CodingSessionNativeTurnId>(receipt.nativeTurnId) }
            } catch (_error: unknown) {
              const uncertainty = new Error('Claude sequential original turn or its persisted readback remains uncertain.')
              if (pendingVerification === undefined) failure = uncertainty
              throw uncertainty
            } finally { pending = false }
          },
          release: async (request) => {
            if (releaseReceipt !== undefined) return releaseReceipt
            // Always stop and await owned work, including when the root was removed.
            await captured.close()
            request.signal.throwIfAborted()
            if (pending || failure !== undefined) throw failure ?? new Error('Claude sequential admitted native work is unresolved.')
            if (pendingVerification !== undefined) {
              const retained = pendingVerification
              expected = await verify(retained.before, retained.receipt, request, true)
              turns.push(retained.receipt); pendingVerification = undefined
            }
            const snapshot = await fresh(request, true)
            if (!sameSnapshot(expected, snapshot)) throw new Error('Claude sequential original source changed before external release.')
            released = true; held = false; leases.delete(entry)
            releaseReceipt = { source, snapshot, processExited: true, streamsDrained: true, expectedPrefixPersisted: true,
              completedTurnPersisted: turns.length > 0, nativeTurnIds: turns.map(turn => brandString<CodingSessionSequentialReleaseReceipt['nativeTurnIds'][number]>(turn.nativeTurnId)),
              noObservedPersistenceErrors: true }
            return releaseReceipt
          },
        }
        const entry = { executor: captured, lease }; leases.add(entry)
        return lease
      } catch (_error: unknown) {
        if (executor !== undefined) await executor.close()
        // The durable service marker retains this failed acquisition; no new owner is admitted here.
        throw new Error('Claude sequential source acquisition could not be confirmed.')
      }
    },
  }
  return { writer, close: async () => {
    closed = true
    const results = await Promise.allSettled([...leases].map(entry => entry.executor.close()))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  } }
}
