/** Lost-owner checkpoint inputs remain public typed records and do not certify old native execution. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { codingSessionRecoveryCheckpoint } from '../src/restart-recovery.ts'
import type { CodingSessionHandoff, CodingSessionMirror, CodingSessionRecoveryAcknowledgement } from '../src/types.ts'

const source: CodingSessionMirror['source'] = { provider: 'claude',
  profileId: brandString<CodingSessionMirror['source']['profileId']>('recovery-profile'),
  nativeSessionId: brandString<CodingSessionMirror['source']['nativeSessionId']>('recovery-original') }
const mirror: CodingSessionMirror = { source, id: brandString<CodingSessionMirror['id']>('recovery-mirror'),
  title: 'Synthetic cold source', cwd: '/fixture/project', writerState: 'unknown', cursor: 'before', events: [], digest: 'before-digest',
  revision: 1, refreshedAt: '2026-10-11T00:00:00.000Z', status: 'ready',
  capabilities: { discover: false, read: true, refresh: false, continue: false, reason: 'source-disconnected' } }
const marker: CodingSessionHandoff = { id: mirror.id, source, project: '/fixture/project',
  executionSessionId: brandString<CodingSessionHandoff['executionSessionId']>('fixture-y-root'),
  ownerToken: brandString<CodingSessionHandoff['ownerToken']>('lost-owner'),
  phase: 'blocked-uncertain', expectedRevision: 1, toolMode: 'conversation', nativeProfileUnchanged: true,
  externalWritersClosed: true, dispatchedTurnCount: 0, nativeTurnIds: [] }
const acknowledgement: CodingSessionRecoveryAcknowledgement = { source, project: '/fixture/project',
  expectedRevision: 1, expectedOwnerToken: marker.ownerToken, externalWritersClosed: true, nativeProfileUnchanged: true,
  acceptUnresolvedTurns: false }

describe('cold recovery receipt admission', () => {
  it.each(['external-ready', 'recovered-acknowledged'] as const)('refuses an already reclaimable %s owner', (phase) => {
    expect(() => codingSessionRecoveryCheckpoint({ ...marker, phase }, mirror, mirror, acknowledgement)).toThrow('does not require')
  })
  it.each(['duplicate-receipt', 'more-receipts-than-admissions'])('refuses %s retained journal evidence', (mode) => {
    const id = brandString<CodingSessionHandoff['nativeTurnIds'][number]>('retained-turn')
    const damaged: CodingSessionHandoff = { ...marker, dispatchedTurnCount: mode === 'duplicate-receipt' ? 2 : 0,
      nativeTurnIds: mode === 'duplicate-receipt' ? [id, id] : [id] }
    expect(() => codingSessionRecoveryCheckpoint(damaged, mirror, mirror, acknowledgement)).toThrow('evidence is inconsistent')
    expect(damaged.nativeTurnIds).toHaveLength(mode === 'duplicate-receipt' ? 2 : 1)
  })
  it('uses the lost phase when no earlier interruption marker was retained and detaches native identities', () => {
    const id = brandString<CodingSessionHandoff['nativeTurnIds'][number]>('retained-turn')
    const retained = { ...marker, phase: 'continuing' as const, dispatchedTurnCount: 1, nativeTurnIds: [id] }
    const receipt = codingSessionRecoveryCheckpoint(retained, mirror, mirror, acknowledgement)
    expect(receipt).toMatchObject({ previousPhase: 'continuing', historyChange: 'unchanged', unresolvedDispatchCount: 0,
      oldProcessExit: 'not-observed', oldStreamsDrain: 'not-observed', nativePersistence: 'not-established' })
    receipt.nativeTurnIds.length = 0; expect(retained.nativeTurnIds).toEqual([id])
  })
})
