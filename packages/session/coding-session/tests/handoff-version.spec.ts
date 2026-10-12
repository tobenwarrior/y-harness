/** New uncertainty-bearing journals refuse predecessor readers instead of silently discarding recovery observations. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { codingSessionHandoffDomain } from '../src/handoff-record.ts'

const predecessorMarker = { id: 'native-mirror', ownerToken: 'native-owner',
  source: { provider: 'codex', profileId: 'selected-profile', nativeSessionId: 'original-native-session' },
  project: '/fixture/project', executionSessionId: 'old-y-root', expectedRevision: 1, phase: 'external-ready',
  toolMode: 'conversation', nativeProfileUnchanged: true, externalWritersClosed: true, dispatchedTurnCount: 0, nativeTurnIds: [] }

describe('ownership journal version refusal', () => {
  it('refuses predecessor reopening after writing a current-format ownership record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-handoff-version-'))
    const backend = new JsonStorageBackend(root)
    try {
      const descriptor = descriptorOf(codingSessionHandoffDomain)
      const current = await backend.kv.open(descriptor)
      await current.putRecord('markers', 'native-mirror', { ...predecessorMarker, recoveryHistory: [{ ownerToken: 'lost-owner',
        previousPhase: 'y-owned', recoveredAt: '2026-10-10T10:00:00.000Z', reviewedRevision: 1, sourceRevision: 1,
        previousCursor: 'cursor-1', sourceCursor: 'cursor-1', sourceDigest: 'retained-digest', dispatchedTurnCount: 0, nativeTurnIds: [],
        unresolvedDispatchCount: 0, oldProcessExit: 'not-observed', oldStreamsDrain: 'not-observed', nativePersistence: 'not-established',
        historyChange: 'unchanged', externalWritersClosed: true, nativeProfileUnchanged: true, acceptedUnresolvedTurns: false }] })
      await current.close()
      const before = await readFile(join(root, 'coding_session_handoffs.json'), 'utf8')
      await expect(backend.kv.open({ ...descriptor, version: 1 })).rejects.toMatchObject({ code: 'version-mismatch' })
      expect(await readFile(join(root, 'coding_session_handoffs.json'), 'utf8')).toBe(before)
    } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
  })
  it('refuses an existing predecessor journal without overwriting or silently migrating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-handoff-predecessor-'))
    const backend = new JsonStorageBackend(root)
    try {
      const descriptor = descriptorOf(codingSessionHandoffDomain)
      const predecessor = await backend.kv.open({ ...descriptor, version: 1 })
      await predecessor.putRecord('markers', 'native-mirror', predecessorMarker)
      await predecessor.close()
      const before = await readFile(join(root, 'coding_session_handoffs.json'), 'utf8')
      await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'version-mismatch' })
      expect(await readFile(join(root, 'coding_session_handoffs.json'), 'utf8')).toBe(before)
    } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
  })
})
