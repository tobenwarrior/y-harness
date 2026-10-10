/** Detached ordinary-Y history transactions use the existing durable single-writer handle. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { codingSessionDigest } from './digest.ts'
import type {
  CodingSessionImportDestinationSummary, CodingSessionDestinationRevision, CodingSessionImportRecoveryIntent,
} from './linked-import-types.ts'
import type { CodingSessionImportDestination } from './linked-import-options.ts'

/** Complete canonical-log and stored metadata limits. */
export interface ColdDestinationBounds {
  readonly maxEvents: number
  readonly maxBytes: number
  readonly maxRecords: number
  readonly timeoutMs: number
}

/** Owns reads, detached writes, cancellation and uncancellable write-handle release. */
export class CodingSessionColdDestinations {
  private readonly lifetime = new AbortController()
  private cancellation = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  /** @param ctx - optional durable Session services. @param bounds - deployment-owned full-log budgets. */
  constructor(private readonly ctx: Context, private readonly bounds: ColdDestinationBounds) {}
  /** Report whether the optional durable import capabilities are available.
   * @returns whether both existing Session services currently support an ordinary-Y destination. */
  available(): boolean {
    return !this.lifetime.signal.aborted && this.ctx.get('sessions') !== undefined && this.ctx.get('sessionPersistence') !== undefined
  }
  /** List ordinary-Y destination metadata within the deployment limits.
   * @returns bounded stored-session metadata without acquiring write authority or reading transcript bodies. */
  list(): Promise<CodingSessionImportDestinationSummary[]> {
    return this.run(async (signal) => {
      const { persistence, sessions } = this.services()
      const values = await persistence.list({ signal }); signal.throwIfAborted()
      const result: CodingSessionImportDestinationSummary[] = []
      for (const value of values) {
        if (value.header.origin === 'subagent' || value.header.cwd === undefined || !isAbsolute(value.header.cwd)) continue
        if (result.length >= this.bounds.maxRecords) throw new Error('Stored import destinations exceeded the configured count limit.')
        result.push({ id: value.header.id, project: value.header.cwd, live: sessions.get(value.header.id) !== undefined })
      }
      this.assertBytes(result); return result
    })
  }
  /** Persist a new empty ordinary-Y destination without creating an Agent.
   * @param project - exact known native project.
   * @returns a persisted empty ordinary-Y Session and its reviewed canonical revision. */
  create(project: string): Promise<{ destinationSessionId: SessionId; revision: CodingSessionDestinationRevision }> {
    return this.run(async (signal) => {
      if (!isAbsolute(project)) throw new Error('Select a known absolute native project before creating an import destination.')
      const { persistence, sessions } = this.services()
      const session = sessions.prepare(brandString<SessionId>(`session-import-${randomUUID()}`), { meta: { cwd: project } })
      const handle = await persistence.create(session.header, { signal })
      try {
        signal.throwIfAborted(); this.current(persistence, sessions, session.id)
        await handle.flush({ signal })
        const events = await this.readCanonical(handle, signal)
        return { destinationSessionId: session.id, revision: this.revision(events) }
      } finally { await handle.close() }
    })
  }
  /** Read the complete canonical destination within its admission budgets.
   * @param id - explicit stored destination.
   * @returns canonical stored events, without taking its write ownership. */
  inspect(id: SessionId): Promise<{ id: SessionId; events: readonly SessionEvent[] }> {
    return this.run(async (signal) => {
      const { persistence, sessions } = this.services()
      this.current(persistence, sessions, id)
      await this.preflight(id, signal)
      const handle = await persistence.open(id, 'read', { signal })
      try {
        if (handle.header.origin === 'subagent') throw new Error('Select an ordinary-Y root Session as the import destination.')
        const events = await this.readCanonical(handle, signal)
        this.current(persistence, sessions, id); return { id, events }
      } finally { await handle.close() }
    })
  }
  /**
   * Acquire the existing persistence owner for one detached transaction; never enter a live Session or create an Agent.
   * @param id - explicit stored ordinary-Y destination.
   * @param use - journal-backed import, recovery or compensation under this owner.
   * @param recovery - exact pending initializer prefix allowed during explicit durable recovery.
   * @returns after all admitted durability and owner release settle.
   */
  withDestination<T>(
    id: SessionId, use: (destination: CodingSessionImportDestination) => Promise<T>, recovery?: CodingSessionImportRecoveryIntent,
  ): Promise<T> {
    return this.run(async (signal) => {
      const { persistence, sessions } = this.services()
      const { interruptedTurnClosers } = await import('@deepseek-ai/dsh-session')
      signal.throwIfAborted(); this.current(persistence, sessions, id)
      await this.preflight(id, signal)
      const handle = await persistence.open(id, 'write', { signal })
      try {
        this.current(persistence, sessions, id)
        if (handle.header.origin === 'subagent') throw new Error('Select an ordinary-Y root Session as the import destination.')
        let persistedEvents = await this.readCanonical(handle, signal)
        if (interruptedTurnClosers(persistedEvents).length > 0
          && !this.matchesRecoveryPrefix(persistedEvents, recovery, interruptedTurnClosers)) {
          throw new Error('Resume the interrupted destination turn before reviewing a cold import.')
        }
        const session = sessions.prepare(id, { seed: structuredClone([...persistedEvents]), meta: structuredClone(handle.header),
          inheritedEventCount: handle.inheritedEventCount, eventState: 'detached' })
        let recorded: readonly SessionEvent[] | undefined
        const destination: CodingSessionImportDestination = {
          session, get persistedEvents() { return persistedEvents },
          appendRecorded: (events) => {
            signal.throwIfAborted(); this.current(persistence, sessions, id)
            if (recorded !== undefined) throw new Error('Prepared destination events were already admitted.')
            recorded = structuredClone(events)
            return Promise.resolve()
          },
          flush: async () => {
            signal.throwIfAborted(); this.current(persistence, sessions, id)
            if (recorded === undefined) throw new Error('The exact planned destination suffix was not admitted before flush.')
            const next = recorded
            this.assertBytes({
              header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: [...persistedEvents, ...next],
            })
            if (persistedEvents.length + next.length > this.bounds.maxEvents) {
              throw new Error('The complete destination log exceeded its event limit.')
            }
            await handle.append(next, { signal }); await handle.flush({ signal })
            persistedEvents = await this.readCanonical(handle, signal); recorded = undefined
            this.current(persistence, sessions, id)
          },
        }
        const result = await use(destination); signal.throwIfAborted(); this.current(persistence, sessions, id)
        return result
      } finally { await handle.close() }
    })
  }
  /** Cancel prior request admission and join each owned transaction.
   * @returns after cancelling prior requests and joining admitted durability and owner release. */
  async cancelPending(): Promise<void> {
    const previous = this.cancellation
    this.cancellation = new AbortController()
    const pending = [...this.pending]
    previous.abort(new Error('Cold import destination request cancelled.'))
    await Promise.allSettled(pending)
  }
  /** Dispose the adapter after its admitted work settles.
   * @returns after cancelling admission and joining every handle's durability and release. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Cold import destinations disposed.'))
    await Promise.allSettled([...this.pending])
  }
  private services() {
    const persistence = this.ctx.get('sessionPersistence'); const sessions = this.ctx.get('sessions')
    if (persistence === undefined || sessions === undefined) throw new Error('Ordinary-Y import requires durable Session storage.')
    return { persistence, sessions }
  }
  private current(
    persistence: ReturnType<CodingSessionColdDestinations['services']>['persistence'],
    sessions: ReturnType<CodingSessionColdDestinations['services']>['sessions'], id: SessionId,
  ): void {
    const currentSessions = this.ctx.get('sessions')
    if (this.ctx.get('sessionPersistence')?.identity !== persistence.identity
      || currentSessions === undefined
      || Reflect.get(currentSessions, Service.tracker) !== Reflect.get(sessions, Service.tracker) || sessions.get(id) !== undefined) {
      throw new Error('The selected destination is live or its durable Session service changed.')
    }
  }
  private async preflight(id: SessionId, signal: AbortSignal): Promise<void> {
    const { persistence } = this.services(); const value = await persistence.stat(id, { signal })
    signal.throwIfAborted()
    if (value !== undefined && (value.eventCount !== undefined && value.eventCount > this.bounds.maxEvents
      || value.sizeBytes !== undefined && value.sizeBytes > this.bounds.maxBytes)) {
      throw new Error('The stored import destination exceeded its complete event or byte limit.')
    }
  }
  private async readCanonical(handle: SessionHandle, signal: AbortSignal): Promise<readonly SessionEvent[]> {
    const { events } = await handle.read(0, this.bounds.maxEvents + 1, { signal }); signal.throwIfAborted()
    if (events.length > this.bounds.maxEvents) throw new Error('The complete destination log exceeded its event limit.')
    this.assertBytes({ header: handle.header, inheritedEventCount: handle.inheritedEventCount, events }); return events
  }
  private matchesRecoveryPrefix(
    events: readonly SessionEvent[], recovery: CodingSessionImportRecoveryIntent | undefined,
    turnClosers: typeof import('@deepseek-ai/dsh-session').interruptedTurnClosers,
  ): boolean {
    if (recovery === undefined) return false
    this.assertBytes(recovery)
    const before = events.slice(0, recovery.before.eventCount)
    if (before.length !== recovery.before.eventCount || codingSessionDigest(before) !== recovery.before.digest
      || turnClosers(before).length > 0) return false
    const suffix = events.slice(recovery.before.eventCount)
    return suffix.length <= recovery.append.length
      && suffix.every((event, index) => codingSessionDigest(event) === codingSessionDigest(recovery.append[index]))
  }
  private revision(events: readonly SessionEvent[]): CodingSessionDestinationRevision {
    return { eventCount: events.length, digest: codingSessionDigest(events) }
  }
  private assertBytes(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.bounds.maxBytes) {
      throw new Error('The complete import destination exceeded its UTF-8 byte limit.')
    }
  }
  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cancellation = this.cancellation.signal
    const work = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted(); cancellation.throwIfAborted()
      return operation(AbortSignal.any([this.lifetime.signal, cancellation, AbortSignal.timeout(this.bounds.timeoutMs)]))
    })
    this.pending.add(work); void work.then(() => { this.pending.delete(work) }, () => { this.pending.delete(work) })
    return work
  }
}
