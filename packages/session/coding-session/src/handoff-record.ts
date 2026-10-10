/** Durable native ownership markers preserve uncertain handoffs independently from history mirrors. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CodingSessionHandoff, CodingSessionMirrorId, CodingSessionNativeId, CodingSessionNativeTurnId, CodingSessionOwnerToken, CodingSessionProfileId } from './types.ts'

const ownerToken = z.string().min(1).transform(value => brandString<CodingSessionOwnerToken>(value))
const nativeTurnId = z.string().min(1).transform(value => brandString<CodingSessionNativeTurnId>(value))
const interruptedPhase = z.enum(['claiming', 'y-owned', 'continuing', 'releasing', 'blocked-uncertain'])
const recoveryCheckpoint = z.object({
  ownerToken, previousPhase: interruptedPhase, recoveredAt: z.iso.datetime(),
  reviewedRevision: z.number().int().positive(), sourceRevision: z.number().int().positive(),
  previousCursor: z.string(), sourceCursor: z.string(), sourceDigest: z.string().min(1),
  dispatchedTurnCount: z.number().int().nonnegative(),
  nativeTurnIds: z.array(nativeTurnId), unresolvedDispatchCount: z.number().int().nonnegative(),
  oldProcessExit: z.literal('not-observed'), oldStreamsDrain: z.literal('not-observed'), nativePersistence: z.literal('not-established'),
  historyChange: z.enum(['unchanged', 'appended']), externalWritersClosed: z.literal(true), nativeProfileUnchanged: z.literal(true),
  acceptedUnresolvedTurns: z.boolean(),
}).refine(value => new Set(value.nativeTurnIds).size === value.nativeTurnIds.length
  && value.nativeTurnIds.length + value.unresolvedDispatchCount === value.dispatchedTurnCount
  && (value.unresolvedDispatchCount === 0 || value.acceptedUnresolvedTurns), 'Recovery admission evidence is inconsistent.')

/** Complete marker validation at durable storage admission. */
export const codingSessionHandoffSchema = z.object({
  id: z.string().min(1).transform(value => brandString<CodingSessionMirrorId>(value)),
  ownerToken,
  source: z.object({ provider: z.enum(['codex', 'claude']), profileId: z.string().min(1).transform(value => brandString<CodingSessionProfileId>(value)), nativeSessionId: z.string().min(1).transform(value => brandString<CodingSessionNativeId>(value)) }),
  project: z.string().min(1).refine(isAbsolute), executionSessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  expectedRevision: z.number().int().positive(),
  phase: z.enum(['claiming', 'y-owned', 'continuing', 'releasing', 'external-ready', 'blocked-uncertain', 'recovered-acknowledged']),
  toolMode: z.enum(['conversation', 'project-files', 'project-tools']), nativeProfileUnchanged: z.literal(true), externalWritersClosed: z.literal(true),
  dispatchedTurnCount: z.number().int().nonnegative(),
  nativeTurnIds: z.array(nativeTurnId), interruptedPhase: interruptedPhase.optional(),
  recoveryHistory: z.array(recoveryCheckpoint).optional(),
}).refine(value => value.phase !== 'recovered-acknowledged' || (value.recoveryHistory?.length ?? 0) > 0,
  'A recovered handoff requires its retained uncertainty checkpoint.')
/** Recovery journal refuses older readers and existing v1 units; preserving conversion is an explicit offline deployment step. */
export const codingSessionHandoffDomain = defineDomain({ name: 'coding_session_handoffs', version: 2, tables: { markers: domainTable<CodingSessionMirrorId, CodingSessionHandoff>(codingSessionHandoffSchema) } })
