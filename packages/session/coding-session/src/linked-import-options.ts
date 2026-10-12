/** Host-owned durable journal and detached Session capabilities; excluded from public browser DTOs. */
import type {} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CodingSessionImportMessageSource, CodingSessionImportRecoveryIntent, CodingSessionLinkId, CodingSessionLinkRecord,
} from './linked-import-types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Producer-framed quoted historical user context. This kind supplies attribution
     * only; readers preserve it without provider-specific replay, approval or routing authority.
     * @persistenceAttribution
     */
    'coding-session-import': CodingSessionImportMessageSource
  }
}

/** Single-open durable journal, supplied by the storage-domain owner. */
export interface CodingSessionLinkStore {
  /** @param id - exact link identity. @returns retained journal record. */
  get(id: CodingSessionLinkId): CodingSessionLinkRecord | undefined
  /** @returns all retained journal records. */
  entries(): IterableIterator<[CodingSessionLinkId, CodingSessionLinkRecord]>
  /** @param id - exact link identity. @param record - complete intent or committed record. @returns after durable publication. */
  put(id: CodingSessionLinkId, record: CodingSessionLinkRecord): Promise<void>
}
/** One detached cold destination under its existing SessionPersistence write owner; live Sessions are unsupported. */
export interface CodingSessionImportDestination {
  session: Session
  /** Canonical stored events, excluding any new detached constructor marker until flush. */
  readonly persistedEvents: readonly SessionEvent[]
  /** Append the exact recorded missing suffix during recovery; flush must not additionally append the detached constructor marker. */
  appendRecorded(events: readonly SessionEvent[]): Promise<void>
  /** Persist only the exact admitted recorded suffix and refresh persistedEvents before resolving. */
  flush(): Promise<void>
}
/** Deployment-owned bounds and cold SessionPersistence single-writer capability; one Host owns the journal. */
export interface CodingSessionLinkedImportOptions {
  store: CodingSessionLinkStore
  maxRecords: number
  maxEvents: number
  maxBytes: number
  maxGenerations: number
  /**
   * @param id - explicit destination.
   * @param use - operation under its existing write owner.
   * @returns operation result after owner release.
   */
  withDestination<T>(
    id: SessionId, use: (destination: CodingSessionImportDestination) => Promise<T>, recovery?: CodingSessionImportRecoveryIntent,
  ): Promise<T>
  /** @param id - explicit destination. @returns canonical stored events without acquiring write ownership. */
  inspectDestination?(id: SessionId): Promise<{ id: SessionId; events: readonly SessionEvent[] }>
}
