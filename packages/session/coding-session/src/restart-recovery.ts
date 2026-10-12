/** Restart checkpoints preserve lost-owner admissions without manufacturing native release evidence. */
import type { CodingSessionHandoff, CodingSessionMirror, CodingSessionRecoveryAcknowledgement, CodingSessionRecoveryCheckpoint } from './types.ts'

/**
 * Retain observed native receipts separately from unaccounted durable admissions.
 * @param marker - reviewed lost owner; no live native handle may remain.
 * @param previous - retained history before the cold read.
 * @param current - matching or append-only cold source history.
 * @param acknowledgement - explicit uncertainty acceptance and cooperative writer/profile assertions.
 * @returns a cold-read checkpoint that grants no old-process release or native persistence certificate.
 */
export function codingSessionRecoveryCheckpoint(
  marker: CodingSessionHandoff, previous: CodingSessionMirror, current: CodingSessionMirror,
  acknowledgement: CodingSessionRecoveryAcknowledgement,
): CodingSessionRecoveryCheckpoint {
  if (marker.phase === 'external-ready' || marker.phase === 'recovered-acknowledged') {
    throw new Error('This native owner does not require restart recovery.')
  }
  const known = new Set(marker.nativeTurnIds)
  if (known.size !== marker.nativeTurnIds.length || known.size > marker.dispatchedTurnCount) {
    throw new Error('Retained native admission evidence is inconsistent. Review the ownership journal.')
  }
  const unresolvedDispatchCount = marker.dispatchedTurnCount - known.size
  if (unresolvedDispatchCount > 0 && ! acknowledgement.acceptUnresolvedTurns) {
    throw new Error('Review and explicitly accept the unresolved native turns before recovering this lost owner.')
  }
  return {
    ownerToken: marker.ownerToken, previousPhase: marker.interruptedPhase ?? marker.phase,
    recoveredAt: new Date().toISOString(), reviewedRevision: previous.revision, sourceRevision: current.revision,
    previousCursor: previous.cursor, sourceCursor: current.cursor, sourceDigest: current.digest,
    dispatchedTurnCount: marker.dispatchedTurnCount, nativeTurnIds: [...marker.nativeTurnIds], unresolvedDispatchCount,
    oldProcessExit: 'not-observed', oldStreamsDrain: 'not-observed', nativePersistence: 'not-established',
    historyChange: current.events.length > previous.events.length ? 'appended' : 'unchanged',
    externalWritersClosed: true, nativeProfileUnchanged: true, acceptedUnresolvedTurns: acknowledgement.acceptUnresolvedTurns,
  }
}
