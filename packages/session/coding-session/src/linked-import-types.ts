/** Explicit ordinary-Y destination mappings and reversible public native-history imports. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { CodingSessionEvent, CodingSessionMirror, CodingSessionMirrorId, CodingSessionSource } from './types.ts'

/** One source-to-destination mapping, independent from the native mirror identity. */
export type CodingSessionLinkId = Branded<'coding-session-link'>
/** Exact canonical persisted destination revision; comparable across Host restart. */
export interface CodingSessionDestinationRevision { eventCount: number; digest: string }
/** Metadata-only ordinary-Y choices; a live Session cannot receive a cold import. */
export interface CodingSessionImportDestinationSummary { id: SessionId; project: string; live: boolean }
/** Distinct historical quoted context; native roles confer no Y execution authority. */
export interface CodingSessionImportMessageSource extends CodingSessionSource {
  kind: 'coding-session-import'
  mirrorId: CodingSessionMirrorId
  linkId: CodingSessionLinkId
  generation: number
  disposition: 'active' | 'rolled-back'
}
/** Per-event mapping into the quoted destination text, with native order and digest retained. */
export interface CodingSessionImportedEventMapping {
  nativeEventId: CodingSessionEvent['id']
  nativeDigest: string
  destinationSeq: SessionSeq
  textStart: number
  textEnd: number
}
/** Parser-admitted quoted or withdrawn user context; its one text block carries no provider replay state. */
export interface CodingSessionImportedUserMessage {
  readonly id: MessageId
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: CodingSessionImportMessageSource
}
/** Exact linked user-event receipt; the parser admits only its recorded surface metadata. */
export interface CodingSessionImportedUserEvent {
  type: 'user/message'
  seq: SessionSeq
  time: number
  data: CodingSessionImportedUserMessage
  surfaceOp: 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
  sourceEventSeqs?: SessionSeq[]
}
/** One retained generation; compensation preserves the original raw event log. */
export interface CodingSessionImportGeneration {
  generation: number
  sourceRevision: number
  rawEvents: CodingSessionEvent[]
  message: CodingSessionImportedUserMessage
  /** Original exact appended envelope, including timestamp and message identity. */
  event: CodingSessionImportedUserEvent
  destinationSeq: SessionSeq
  mappings: CodingSessionImportedEventMapping[]
  status: 'active' | 'rolled-back'
  rollbackSeq?: SessionSeq | undefined
}
/** Local ownership attribution; omitting this record cannot change Session reconstruction. */
export interface CodingSessionImportInitialization {
  source: CodingSessionSource
  mirrorId: CodingSessionMirrorId
  linkId: CodingSessionLinkId
  systemMessageId: MessageId
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Informational local initializer receipt; no task, dispatch, usage or successful native release is implied. */
    'coding-session/import-initialization': CodingSessionImportInitialization
  }
}
/** Exact parser-admitted detached envelopes; no generic turn outcomes or message-source vocabulary is exposed. */
export type CodingSessionImportPlannedEvent =
  | CodingSessionImportedUserEvent
  | { type: 'session/end-seed'; seq: SessionSeq; time: number; data: { inherited?: true } }
  | { type: 'turn/start'; seq: SessionSeq; time: number; data: { turn: number } }
  | { type: 'step/start'; seq: SessionSeq; time: number; data: { turn: number; step: 1 } }
  | {
    type: 'system/message'
    seq: SessionSeq
    time: number
    data: {
      turn: number
      step: 1
      message: { id: MessageId; role: 'system'; content: never[]; source: { kind: 'system-prompt' } }
    }
    surfaceOp: 'append'
  }
  | {
    type: 'coding-session/import-initialization'
    seq: SessionSeq
    time: number
    data: CodingSessionImportInitialization
    ignorable: true
  }
  | { type: 'step/end'; seq: SessionSeq; time: number; data: { turn: number; step: 1 } }
  | { type: 'turn/end'; seq: SessionSeq; time: number; data: { turn: number; reason: { kind: 'blocked' } } }
/** Exact already validated journal intent; only explicit recovery may supply it to cold storage. */
export type CodingSessionImportRecoveryIntent = Pick<CodingSessionImportPending, 'before' | 'append'>
/** Write-ahead intent survives a failure before or after destination flush. */
export interface CodingSessionImportPending {
  kind: 'import' | 'rollback'
  before: CodingSessionDestinationRevision
  append: CodingSessionImportPlannedEvent[]
  nextMirror: CodingSessionMirror
  nextGenerations: CodingSessionImportGeneration[]
}
/** Versioned durable mapping; pending intent is never reported as committed history. */
export interface CodingSessionLinkRecord {
  version: 1
  id: CodingSessionLinkId
  mirrorId: CodingSessionMirrorId
  source: CodingSessionSource
  destinationSessionId: SessionId
  project: string
  revision: number
  status: 'active' | 'rolled-back' | 'conflict'
  conflict?: 'history-diverged' | undefined
  mirror: CodingSessionMirror
  generations: CodingSessionImportGeneration[]
  pending?: CodingSessionImportPending | undefined
}
/** Metadata-only linked history inventory; quoted transcript bodies remain in detail. */
export interface CodingSessionLinkSummary {
  id: CodingSessionLinkId
  mirrorId: CodingSessionMirrorId
  source: CodingSessionSource
  destinationSessionId: SessionId
  project: string
  revision: number
  status: CodingSessionLinkRecord['status']
  conflict?: 'history-diverged' | undefined
  prepared: boolean
  generationCount: number
  importedEventCount: number
}
/** Exact reviewed selection; omitted link revision is admitted only for a new mapping. */
export interface CodingSessionImportAcknowledgement {
  destinationSessionId: SessionId
  expectedDestinationRevision: CodingSessionDestinationRevision
  expectedMirrorRevision: number
  expectedLinkRevision?: number
}
/** Exact reviewed mapping and canonical destination log before compensation. */
export interface CodingSessionRollbackAcknowledgement {
  expectedLinkRevision: number
  expectedDestinationRevision: CodingSessionDestinationRevision
}
