/** Durable ownership marker admission preserves exact operational acknowledgements and tool modes. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { codingSessionHandoffSchema } from '../src/handoff-record.ts'
import type { CodingSessionHandoff } from '../src/types.ts'

const marker: CodingSessionHandoff = { id: brandString<CodingSessionHandoff['id']>('mirror-a'), ownerToken: brandString<CodingSessionHandoff['ownerToken']>('owner-token'),
  source: { provider: 'codex', profileId: brandString<CodingSessionHandoff['source']['profileId']>('original-profile'), nativeSessionId: brandString<CodingSessionHandoff['source']['nativeSessionId']>('original-session') },
  project: '/fixture/project', executionSessionId: brandString<CodingSessionHandoff['executionSessionId']>('root-a'), expectedRevision: 1,
  phase: 'y-owned', toolMode: 'project-files', nativeProfileUnchanged: true, externalWritersClosed: true,
  dispatchedTurnCount: 0, nativeTurnIds: [] }
describe('native handoff durable marker', () => {
  it('retains both acknowledged preconditions and the confined file mode', () => {
    expect(codingSessionHandoffSchema.parse(marker)).toEqual(marker)
  })
  it.each([
    { nativeProfileUnchanged: false }, { externalWritersClosed: false }, { project: 'relative-project' },
    { toolMode: 'shell' }, { dispatchedTurnCount: -1 }, { nativeTurnIds: [''] },
  ])('refuses damaged or weaker durable marker fields %j', (change) => {
    expect(codingSessionHandoffSchema.safeParse({ ...marker, ...change }).success).toBe(false)
  })
})
