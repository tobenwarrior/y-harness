/** Read-only native coding-session vocabulary; imported history grants no model or tool authority. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'
import type { CodingSessionImportDestinationSummary, CodingSessionLinkSummary } from './linked-import-types.ts'

export type * from './linked-import-types.ts'

/** Opaque Y-owned mirror identity; native IDs remain under their authorized source. */
export type CodingSessionMirrorId = Branded<'coding-session-mirror'>
/** Opaque identity of one authorized provider connection or configured SDK scope. */
export type CodingSessionProfileId = Branded<'coding-session-profile'>
/** Original native identity, meaningful only with its provider and profile. */
export type CodingSessionNativeId = Branded<'coding-session-native'>
/** Stable native event identity within the original source history. */
export type CodingSessionEventId = Branded<'coding-session-event'>
/** Opaque owned-process instance token, published before acquisition. */
export type CodingSessionOwnerToken = Branded<'coding-session-owner'>
/** Provider-owned native turn identity, scoped by its original source. */
export type CodingSessionNativeTurnId = Branded<'coding-session-native-turn'>
/** An authorized configured native profile or connection scope. */
export interface CodingSessionProfile { provider: 'codex' | 'claude'; profileId: CodingSessionProfileId }
/** Original native identity; profileId must identify the actual configured source scope. */
export interface CodingSessionSource extends CodingSessionProfile { nativeSessionId: CodingSessionNativeId }
/** Native API observations do not exclude an independent CLI writer. */
export type CodingSessionWriterState = 'idle' | 'active' | 'unknown'
/** Display capabilities enforced by the Host, independent from native idle state. */
export interface CodingSessionCapabilities { discover: boolean; read: boolean; refresh: boolean; continue: boolean; reason: 'native-writer-handoff-unavailable' | 'exclusive-native-writer' | 'source-disconnected' }
/** One stable native event; digest covers native fields beyond the display projection. */
export interface CodingSessionEvent { id: CodingSessionEventId; role: 'user' | 'assistant' | 'system' | 'tool'; text: string; digest: string }
/** Native metadata safe to browse before an explicit import. */
export interface CodingSessionSummary {
  source: CodingSessionSource
  title: string
  cwd?: string | undefined
  writerState: CodingSessionWriterState
}
/** A bounded complete native history snapshot, never an append delta. */
export interface CodingSessionSnapshot extends CodingSessionSummary { events: CodingSessionEvent[]; cursor: string }
/** Native list pagination retains opaque provider-owned cursors. */
export interface CodingSessionPage { items: CodingSessionSummary[]; nextCursor?: string }
/** Durable source-labelled Y mirror, separate from runnable Harness chat sessions. */
export interface CodingSessionMirror extends CodingSessionSnapshot {
  id: CodingSessionMirrorId
  revision: number
  digest: string
  refreshedAt: string
  status: 'ready' | 'conflict'
  conflict?: 'history-diverged' | undefined
  capabilities: CodingSessionCapabilities
  /** Live sequential capability and ownership are not stored in the history table. */
  sequentialAvailable?: boolean
  sequentialReleaseAvailable?: boolean
  sequentialToolMode?: CodingSessionSequentialToolMode
  handoff?: CodingSessionHandoff
}
/** Configured native source readiness and honest operation disclosure. */
export interface CodingSessionProviderView extends CodingSessionProfile {
  label: string
  connected: boolean
  capabilities: CodingSessionCapabilities
}
/** Metadata-only Y mirror listing; full history is requested through detail. */
export type CodingSessionMirrorSummary = Omit<CodingSessionMirror, 'events'> & { eventCount: number }
/** Read-only settings inventory and mirror summaries. */
export interface CodingSessionsState {
  sources: CodingSessionProviderView[]
  mirrors: CodingSessionMirrorSummary[]
  executionSessions?: CodingSessionExecutionSession[]
  linkedImportsAvailable?: boolean
  links?: CodingSessionLinkSummary[]
  importDestinations?: CodingSessionImportDestinationSummary[]
}
/** Operation-scoped limits and cancellation; adapters do not mutate native histories. */
export interface CodingSessionReadRequest { signal: AbortSignal; limit: number; maxEvents: number; maxBytes: number }
/** Public native discovery/read operations. Current read providers do not establish a safe client-owned continuation handoff. */
export interface CodingSessionProvider extends CodingSessionProfile {
  label: string
  /** Optional supported native exclusion API; not established by the current Codex and Claude read adapters. */
  writer?: CodingSessionWriterProvider
  /** Separate opted-in operational handoff; it does not exclude arbitrary external native writers. */
  sequentialWriter?: CodingSessionSequentialWriterProvider
  /** @returns whether the exact configured native connection is available. */
  connected(): boolean
  /** @param request - bounded operation lifetime. @param cursor - native pagination token. @returns one native metadata page. */
  discover(request: CodingSessionReadRequest, cursor?: string): Promise<CodingSessionPage>
  /**
   * @param nativeSessionId - original source ID, never a created replacement.
   * @param request - bounded operation lifetime.
   * @returns complete stable history or explicit failure.
   */
  read(nativeSessionId: CodingSessionNativeId, request: CodingSessionReadRequest): Promise<CodingSessionSnapshot>
}
/** Durable mirror table owned by the service, not the native provider. */
export interface CodingSessionStore {
  /** @param id - Y mirror identity. @returns retained mirror, if present. */
  get(id: CodingSessionMirrorId): CodingSessionMirror | undefined
  /** @returns all retained mirrors. */
  entries(): IterableIterator<[CodingSessionMirrorId, CodingSessionMirror]>
  /** @param id - Y mirror identity. @param mirror - complete record. @returns completion after durable publication. */
  put(id: CodingSessionMirrorId, mirror: CodingSessionMirror): Promise<void>
}
/** Deployment-owned discovery, retention, and read deadline limits. */
export interface CodingSessionLibraryOptions {
  store: CodingSessionStore
  pageSize: number
  maxEvents: number
  maxMirrors: number
  maxBytes: number
  timeoutMs: number
  /** Default-off sequential mode also requires an independent durable ownership store. */
  enableSequentialHandoff?: boolean
  /** Native turn deadline is separate from metadata-read deadlines. */
  sequentialTurnTimeoutMs?: number
  handoffStore?: CodingSessionHandoffStore
}

/** Native-enforced exclusive writer ownership, never a Y-local lease or idle observation. */
export interface CodingSessionWriterProvider {
  authority: 'native-enforced-exclusion'
  /**
   * Atomically exclude every native/external writer and verify idle state before returning.
   * @param source - original native identity.
   * @param request - bounded lifetime.
   * @returns held native ownership or rejection when busy/unknown.
   */
  acquire(source: CodingSessionSource, request: CodingSessionReadRequest): Promise<CodingSessionWriterLease>
}
/** Held native exclusion covers reads, original-ID resume, settlement, and release. */
export interface CodingSessionWriterLease {
  source: CodingSessionSource
  /** @param request - bounded lifetime. @returns full native history while exclusive ownership remains held. */
  read(request: CodingSessionReadRequest): Promise<CodingSessionSnapshot>
  /**
   * Preserve original identity, native permissions, approvals and sandbox; no history copy or replacement session.
   * @param request - exact source, human text and cancellation.
   * @returns after the native turn settles, including cancelled/error outcomes.
   */
  resumeOriginal(request: { source: CodingSessionSource; text: string; signal: AbortSignal }): Promise<void>
  /**
   * Release must await native quiescence even when cancellation or reconnection occurred.
   * @returns completion once native writer ownership is released.
   */
  release(): Promise<void>
}

/** Human-selected live root supplying the current Y execution approvals and sandbox policy. */
export interface CodingSessionExecutionSession { id: SessionId; project: string }
/** Exact reviewed selection and operational acknowledgement; no global native lock is implied. */
export interface CodingSessionClaimAcknowledgement {
  source: CodingSessionSource
  project: string
  expectedRevision: number
  executionSessionId: SessionId
  externalWritersClosed: boolean
  nativeProfileUnchanged: boolean
}
/** Native conversation-only mode and project execution require distinct capability disclosure. */
export type CodingSessionSequentialToolMode = 'conversation' | 'project-files' | 'project-tools'
/** Persisted phases retain unresolved ownership when the Host or native child stops unexpectedly. */
export type CodingSessionHandoffPhase = 'claiming' | 'y-owned' | 'continuing' | 'releasing' | 'external-ready' | 'blocked-uncertain' | 'recovered-acknowledged'
/** Phases whose old native process cannot be reconstructed after Host restart. */
export type CodingSessionInterruptedHandoffPhase = Exclude<CodingSessionHandoffPhase, 'external-ready' | 'recovered-acknowledged'>
/** Exact lost-owner review; stopped writers and stable profiles remain cooperative operator assertions. */
export interface CodingSessionRecoveryAcknowledgement {
  source: CodingSessionSource
  project: string
  expectedRevision: number
  expectedOwnerToken: CodingSessionOwnerToken
  externalWritersClosed: boolean
  nativeProfileUnchanged: boolean
  /** Must be true when a durable admission lacks a recorded native turn receipt. */
  acceptUnresolvedTurns: boolean
}
/** Cold retained-prefix observation permits a separate claim; it never certifies the old owner's release. */
export interface CodingSessionRecoveryCheckpoint {
  ownerToken: CodingSessionOwnerToken
  previousPhase: CodingSessionInterruptedHandoffPhase
  recoveredAt: string
  reviewedRevision: number
  sourceRevision: number
  previousCursor: string
  sourceCursor: string
  sourceDigest: string
  dispatchedTurnCount: number
  nativeTurnIds: CodingSessionNativeTurnId[]
  unresolvedDispatchCount: number
  oldProcessExit: 'not-observed'
  oldStreamsDrain: 'not-observed'
  nativePersistence: 'not-established'
  /** Change in projected events only; cursor changes may also represent omitted native metadata. */
  historyChange: 'unchanged' | 'appended'
  externalWritersClosed: true
  nativeProfileUnchanged: true
  acceptedUnresolvedTurns: boolean
}
/** Minimal original-source ownership marker; it stores neither credentials nor transcript text. */
export interface CodingSessionHandoff {
  id: CodingSessionMirrorId
  ownerToken: CodingSessionOwnerToken
  source: CodingSessionSource
  project: string
  executionSessionId: SessionId
  expectedRevision: number
  phase: CodingSessionHandoffPhase
  toolMode: CodingSessionSequentialToolMode
  nativeProfileUnchanged: true
  externalWritersClosed: true
  dispatchedTurnCount: number
  nativeTurnIds: CodingSessionNativeTurnId[]
  /** Original phase retained when restart blocks a lost process handle. */
  interruptedPhase?: CodingSessionInterruptedHandoffPhase | undefined
  /** Bounded prior-owner uncertainty survives subsequent claims and releases. */
  recoveryHistory?: CodingSessionRecoveryCheckpoint[] | undefined
}
/** Independently versioned durable ownership markers, separate from native history mirrors. */
export interface CodingSessionHandoffStore {
  /** @param id - Y mirror identity. @returns its retained ownership marker. */
  get(id: CodingSessionMirrorId): CodingSessionHandoff | undefined
  /** @returns all retained ownership markers. */
  entries(): IterableIterator<[CodingSessionMirrorId, CodingSessionHandoff]>
  /** @param id - Y mirror identity. @param marker - complete ownership state. @returns after durable publication. */
  put(id: CodingSessionMirrorId, marker: CodingSessionHandoff): Promise<void>
  /**
   * Transform the current marker at its serialized durable-write slot; required for restart recovery.
   * @param id - retained Y mirror identity.
   * @param transform - synchronous review and replacement; throwing leaves the current marker unchanged.
   * @returns replacement after durable publication, or rejection without an update.
   */
  update?(id: CodingSessionMirrorId, transform: (current: CodingSessionHandoff) => CodingSessionHandoff): Promise<CodingSessionHandoff>
}
/** Acquisition owns a pre-published opaque process-instance token; piped process IDs are unavailable. */
export interface CodingSessionSequentialAcquireRequest extends CodingSessionReadRequest {
  ownerToken: CodingSessionOwnerToken
  nativeProfileUnchanged: true
}
/** Separate operational writer after the user closes every prior writer of this original session. */
export interface CodingSessionSequentialWriterProvider {
  authority: 'user-acknowledged-sequential'
  toolMode: CodingSessionSequentialToolMode
  /**
   * Cold-claim the original session without starting a model turn; use the current live root's policy.
   * @param source - exact authorized original identity.
   * @param request - acquisition limits, cancellation and durably published owner token.
   * @returns the original-source owner; caller retains the prior-writer-close precondition.
   */
  acquire(source: CodingSessionSource, request: CodingSessionSequentialAcquireRequest): Promise<CodingSessionSequentialWriterLease>
}
/** Fresh native readback follows a drained, naturally exited owned process; it is no recorder-wide certificate. */
export interface CodingSessionSequentialReleaseReceipt {
  source: CodingSessionSource
  snapshot: CodingSessionSnapshot
  processExited: true
  streamsDrained: true
  expectedPrefixPersisted: true
  completedTurnPersisted: boolean
  nativeTurnIds: CodingSessionNativeTurnId[]
  noObservedPersistenceErrors: true
}
/** Fresh current-task callbacks; historical native messages never supply these facts. */
export interface CodingSessionSequentialObserver {
  signal: AbortSignal
  /** @returns after current task admission is durable, before native dispatch. */
  beforeDispatch(): Promise<void>
  /** @param id - actual current native turn identity. @returns after durable correlation. */
  onNativeTurn(id: string): Promise<void>
  /** @param item - current paired sanitized item metadata. @returns after durable capture. */
  onNativeItem(item: SkillLearningNativeItem): Promise<void>
}
/** Held sequential native owner; the registered provider discloses its supported tool mode. */
export interface CodingSessionSequentialWriterLease {
  source: CodingSessionSource
  /** @param request - bounded read lifetime. @returns the original source's complete retained native history. */
  read(request: CodingSessionReadRequest): Promise<CodingSessionSnapshot>
  /**
   * Resume the same original ID under the captured live root's policy and declared tool mode.
   * @param request - exact source, human text, cancellation and durable admission callback;
   * await it once immediately before native dispatch.
   * @returns its exact settled native turn ID; settlement alone does not confirm persistence.
   */
  resumeOriginal(request: {
    source: CodingSessionSource
    text: string
    signal: AbortSignal
    beforeDispatch(): Promise<void>
    onNativeTurn?(id: string): Promise<void>
    onNativeItem?(item: SkillLearningNativeItem): Promise<void>
  }): Promise<{ nativeTurnId: CodingSessionNativeTurnId }>
  /**
   * Reject forced termination, missing readback, unresolved persistence and process/stream uncertainty.
   * @param request - independent bounded release/readback lifetime; cancellation still drains owned processes.
   * @returns fresh original-source history and independently established release evidence.
   */
  release(request: CodingSessionReadRequest): Promise<CodingSessionSequentialReleaseReceipt>
}
