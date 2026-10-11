/** Native JSON identity and durable recovery evidence are admitted without asserting process release. */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codingSessionDigest } from '../src/digest.ts'
import { codingSessionHandoffSchema } from '../src/handoff-record.ts'

function recoveryMarker(checkpointChanges: Record<string, unknown> = {}) {
  return {
    id: 'fixture-mirror', ownerToken: 'fixture-current-owner',
    source: { provider: 'codex', profileId: 'fixture-profile', nativeSessionId: 'fixture-native-session' },
    project: resolve('fixture-project'), executionSessionId: 'fixture-execution', expectedRevision: 3,
    phase: 'recovered-acknowledged', toolMode: 'conversation', nativeProfileUnchanged: true, externalWritersClosed: true,
    dispatchedTurnCount: 0, nativeTurnIds: [],
    recoveryHistory: [{
      ownerToken: 'fixture-lost-owner', previousPhase: 'continuing', recoveredAt: '2026-10-11T00:00:00.000Z',
      reviewedRevision: 2, sourceRevision: 3, previousCursor: 'before', sourceCursor: 'after', sourceDigest: 'fixture-digest',
      dispatchedTurnCount: 1, nativeTurnIds: ['fixture-native-turn'], unresolvedDispatchCount: 0,
      oldProcessExit: 'not-observed', oldStreamsDrain: 'not-observed', nativePersistence: 'not-established',
      historyChange: 'appended', externalWritersClosed: true, nativeProfileUnchanged: true,
      acceptedUnresolvedTurns: false, ...checkpointChanges,
    }],
  }
}

describe('native JSON identity', () => {
  it('gives reordered nested object keys one identity while retaining array order and Unicode', () => {
    const first = { z: null, m: { y: true, b: 1 }, a: [{ z: '🙂', a: 2 }, 'entry'] }
    const reordered = { a: [{ a: 2, z: '🙂' }, 'entry'], m: { b: 1, y: true }, z: null }
    // SHA-256 of {"a":[{"a":2,"z":"🙂"},"entry"],"m":{"b":1,"y":true},"z":null}.
    const expected = 'daf61bd4613b1122a8cec701bfbc8fdf941679fd0f3b2b7d4ada298814fdbf88'
    expect(codingSessionDigest(first)).toBe(expected)
    expect(codingSessionDigest(reordered)).toBe(expected)
    expect(codingSessionDigest({ ...reordered, a: ['entry', { a: 2, z: '🙂' }] })).not.toBe(expected)
  })

  it('refuses an unknown root value that has no JSON encoding', () => {
    expect(() => codingSessionDigest(undefined)).toThrow('non-JSON history')
  })
})

describe('durable handoff recovery admission', () => {
  it('retains correlated native turns and uncertainty without treating acknowledgement as release evidence', () => {
    const admitted = codingSessionHandoffSchema.parse(recoveryMarker())
    expect(admitted.phase).toBe('recovered-acknowledged')
    expect(admitted.recoveryHistory).toMatchObject([{
      ownerToken: 'fixture-lost-owner', previousPhase: 'continuing', reviewedRevision: 2, sourceRevision: 3,
      nativeTurnIds: ['fixture-native-turn'], dispatchedTurnCount: 1, unresolvedDispatchCount: 0,
      oldProcessExit: 'not-observed', oldStreamsDrain: 'not-observed', nativePersistence: 'not-established',
      acceptedUnresolvedTurns: false,
    }])
  })

  it('admits unresolved dispatches only with the retained explicit acknowledgement', () => {
    const admitted = codingSessionHandoffSchema.parse(recoveryMarker({
      dispatchedTurnCount: 2, unresolvedDispatchCount: 1, acceptedUnresolvedTurns: true,
    }))
    expect(admitted.recoveryHistory).toMatchObject([{
      nativeTurnIds: ['fixture-native-turn'], dispatchedTurnCount: 2, unresolvedDispatchCount: 1,
      acceptedUnresolvedTurns: true, nativePersistence: 'not-established',
    }])
  })

  it.each([
    { nativeTurnIds: ['fixture-native-turn', 'fixture-native-turn'], dispatchedTurnCount: 2 },
    { dispatchedTurnCount: 2 },
    { dispatchedTurnCount: 2, unresolvedDispatchCount: 1 },
  ])('refuses inconsistent recovery accounting in durable input: %j', (checkpointChanges) => {
    expect(() => codingSessionHandoffSchema.parse(recoveryMarker(checkpointChanges)))
      .toThrow('Recovery admission evidence is inconsistent')
  })

  it.each([undefined, []])('refuses recovered ownership without retained uncertainty history: %j', (recoveryHistory) => {
    expect(() => codingSessionHandoffSchema.parse({ ...recoveryMarker(), recoveryHistory }))
      .toThrow('requires its retained uncertainty checkpoint')
  })
})
