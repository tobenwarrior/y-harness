/** Synthetic cold destinations and lost-owner records; no real native/session work. */
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionLinkRecord, CodingSessionLinkSummary, CodingSessionDestinationRevision } from '@deepseek-ai/dsh-coding-session/types'
import type { CodingSessionMirror } from '@deepseek-ai/dsh-coding-session/types'
type SessionId = CodingSessionLinkRecord['destinationSessionId']
import { fixtureApi, mirror, ok } from './fixtures.client.ts'
export const coldId = brandString<SessionId>('cold-y')
export const liveId = brandString<SessionId>('live-y')
export const otherId = brandString<SessionId>('other-project-y')
export const destinationRevision: CodingSessionDestinationRevision = { eventCount: 3, digest: 'canonical-destination-before' }
const linkId = brandString<CodingSessionLinkRecord['id']>('link-a')
const importedSeq = brandNumber<CodingSessionLinkRecord['generations'][number]['destinationSeq']>(2)
const quotedMessage: CodingSessionLinkRecord['generations'][number]['message'] = { id: brandString<CodingSessionLinkRecord['generations'][number]['message']['id']>('quoted-fixture-message'), role: 'user', content: [{ type: 'text', text: 'Quoted historical native context: Inspect parser' }], source: { ...mirror.source, kind: 'coding-session-import', mirrorId: mirror.id, linkId, generation: 1, disposition: 'active' } }
export const link: CodingSessionLinkRecord = { version: 1, id: linkId, mirrorId: mirror.id, source: mirror.source, destinationSessionId: coldId, project: mirror.cwd!, revision: 1, status: 'active', mirror, generations: [{ generation: 1, sourceRevision: mirror.revision, rawEvents: mirror.events, message: quotedMessage, event: { type: 'user/message', seq: importedSeq, time: 1791590400000, data: quotedMessage, surfaceOp: 'append' }, destinationSeq: importedSeq, mappings: [{ nativeEventId: mirror.events[0]!.id, nativeDigest: mirror.events[0]!.digest, destinationSeq: importedSeq, textStart: 34, textEnd: 48 }], status: 'active' }] }

export function summary(value: CodingSessionLinkRecord): CodingSessionLinkSummary {
  return {
    id: value.id, mirrorId: value.mirrorId, source: value.source, destinationSessionId: value.destinationSessionId,
    project: value.project, revision: value.revision, status: value.status, prepared: value.pending !== undefined,
    generationCount: value.generations.length,
    importedEventCount: value.generations.reduce((count, generation) => count + generation.rawEvents.length, 0),
  }
}
export const interrupted: CodingSessionMirror = { ...mirror, sequentialAvailable: true, sequentialReleaseAvailable: false, sequentialToolMode: 'conversation', handoff: {
  id: mirror.id, source: mirror.source, project: mirror.cwd!, expectedRevision: mirror.revision, executionSessionId: liveId,
  ownerToken: brandString<NonNullable<CodingSessionMirror['handoff']>['ownerToken']>('lost-owner'), phase: 'blocked-uncertain', interruptedPhase: 'continuing', toolMode: 'conversation', nativeProfileUnchanged: true, externalWritersClosed: true, dispatchedTurnCount: 2, nativeTurnIds: [brandString<NonNullable<CodingSessionMirror['handoff']>['nativeTurnIds'][number]>('turn-receipt')],
} }
export function recovered(phase: 'recovered-acknowledged' | 'external-ready' = 'recovered-acknowledged'): CodingSessionMirror {
  return { ...interrupted, revision: 2, handoff: { ...interrupted.handoff!, phase, recoveryHistory: [{ ownerToken: interrupted.handoff!.ownerToken, previousPhase: 'continuing', recoveredAt: '2026-10-10T00:00:00Z', reviewedRevision: 1, sourceRevision: 2, previousCursor: mirror.cursor, sourceCursor: mirror.cursor, sourceDigest: mirror.digest, dispatchedTurnCount: 2, nativeTurnIds: interrupted.handoff!.nativeTurnIds, unresolvedDispatchCount: 1, oldProcessExit: 'not-observed', oldStreamsDrain: 'not-observed', nativePersistence: 'not-established', historyChange: 'unchanged', externalWritersClosed: true, nativeProfileUnchanged: true, acceptedUnresolvedTurns: true }] } }
}
export function linkedFixture(selected = mirror, retainedLinks: CodingSessionLinkRecord[] = []) {
  const api = fixtureApi()
  const { events, ...metadata } = selected
  api.getState = () => ok({ sources: [], mirrors: [{ ...metadata, eventCount: events.length }], executionSessions: [{ id: liveId, project: mirror.cwd! }], linkedImportsAvailable: true, links: retainedLinks.map(summary), importDestinations: [{ id: coldId, project: mirror.cwd!, live: false }, { id: liveId, project: mirror.cwd!, live: true }, { id: otherId, project: '/different/project', live: false }] })
  api.detail = () => ok(selected)
  api.createImportDestination = () => ok({ destinationSessionId: coldId, revision: destinationRevision })
  api.inspectImportDestination = id => ok({ destinationSessionId: id, revision: destinationRevision })
  api.importIntoSession = () => ok(link)
  api.linkedDetail = () => ok(retainedLinks[0] ?? link)
  api.rollbackImport = () => ok({ ...link, revision: 2, status: 'rolled-back' })
  api.recoverImport = () => ok({ ...link, revision: 2 })
  api.abandonImport = () => ok({ ...link, revision: 2 })
  api.recoverSequential = () => ok(recovered())
  return api
}
