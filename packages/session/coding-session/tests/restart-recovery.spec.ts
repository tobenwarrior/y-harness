/** Lost native handles require reviewed cold history and explicit uncertainty, never synthetic release receipts. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CodingSessionLibrary } from '../src/library.ts'
import { codingSessionHandoffSchema } from '../src/handoff-record.ts'
import type { CodingSessionHandoff, CodingSessionMirror, CodingSessionProvider, CodingSessionSnapshot, CodingSessionRecoveryAcknowledgement } from '../src/types.ts'

const source: CodingSessionSnapshot['source'] = {
  provider: 'codex', profileId: brandString<CodingSessionSnapshot['source']['profileId']>('selected-profile'),
  nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('original-native-id'),
}
const initial: CodingSessionSnapshot = { source, title: 'Original task', cwd: '/fixture/project', writerState: 'unknown', cursor: 'cursor-1',
  events: [{ id: brandString<CodingSessionSnapshot['events'][number]['id']>('native-event-1'), role: 'user', text: 'Original request', digest: 'payload-1' }] }

async function fixture(dispatched = 0, recorded: string[] = [], sequentialEnabled = true) {
  const records = new Map<CodingSessionMirror['id'], CodingSessionMirror>()
  const markers = new Map<CodingSessionMirror['id'], CodingSessionHandoff>()
  let history = structuredClone(initial)
  let nativeEffects = 0
  let writesFail = false
  let onRead: (() => void) | undefined
  let queuedOwnerChange = false
  const drainQueuedOwnerChange = (id: CodingSessionMirror['id']): void => {
    if (!queuedOwnerChange) return
    queuedOwnerChange = false
    markers.set(id, { ...markers.get(id)!, ownerToken: brandString<CodingSessionHandoff['ownerToken']>('queued-new-owner') })
  }
  const provider: CodingSessionProvider = { ...source, label: 'Selected original source', connected: () => true,
    discover: async () => ({ items: [history] }), read: async () => { onRead?.(); return structuredClone(history) },
    sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: 'conversation', acquire: async (selected) => {
      nativeEffects++
      return { source: selected, read: async () => structuredClone(history), resumeOriginal: async () => { throw new Error('No native turn expected') },
        release: async () => {
          nativeEffects++
          return { source, snapshot: structuredClone(history), processExited: true, streamsDrained: true,
            expectedPrefixPersisted: true, completedTurnPersisted: false, nativeTurnIds: [], noObservedPersistenceErrors: true } } }
    } },
  }
  const options = { store: { get: (id: CodingSessionMirror['id']) => records.get(id), entries: () => records.entries(),
    put: async (id: CodingSessionMirror['id'], value: CodingSessionMirror) => { records.set(id, structuredClone(value)) } },
  pageSize: 20, maxEvents: 20, maxMirrors: 20, maxBytes: 20000, timeoutMs: 1000, enableSequentialHandoff: sequentialEnabled,
  handoffStore: { get: (id: CodingSessionMirror['id']) => markers.get(id), entries: () => markers.entries(),
    put: async (id: CodingSessionMirror['id'], marker: CodingSessionHandoff) => {
      if (marker.phase === 'recovered-acknowledged') drainQueuedOwnerChange(id)
      if (writesFail) throw new Error('Journal unavailable'); markers.set(id, structuredClone(marker))
    },
    update: async (id: CodingSessionMirror['id'], transform: (current: CodingSessionHandoff) => CodingSessionHandoff) => {
      drainQueuedOwnerChange(id)
      const next = transform(structuredClone(markers.get(id)!))
      if (writesFail) throw new Error('Journal unavailable')
      markers.set(id, structuredClone(next)); return next
    } } }
  const before = new CodingSessionLibrary(options); before.register(provider)
  const mirror = await before.importSession(source); await before.close()
  const oldOwner = brandString<CodingSessionHandoff['ownerToken']>('lost-owner-token')
  markers.set(mirror.id, { id: mirror.id, ownerToken: oldOwner, source, project: '/fixture/project',
    executionSessionId: brandString<CodingSessionHandoff['executionSessionId']>('old-y-root'), expectedRevision: mirror.revision,
    phase: dispatched > 0 ? 'continuing' : 'y-owned', toolMode: 'conversation', nativeProfileUnchanged: true, externalWritersClosed: true,
    dispatchedTurnCount: dispatched, nativeTurnIds: recorded.map(id => brandString<CodingSessionHandoff['nativeTurnIds'][number]>(id)) })
  const library = new CodingSessionLibrary(options); library.register(provider)
  await library.discover(source)
  const acknowledgement = (): CodingSessionRecoveryAcknowledgement => ({ source, project: '/fixture/project',
    expectedRevision: mirror.revision, expectedOwnerToken: oldOwner, externalWritersClosed: true,
    nativeProfileUnchanged: true, acceptUnresolvedTurns: false })
  return { library, records, markers, mirror, oldOwner, acknowledgement, provider,
    handoffStore: options.handoffStore, queueOwnerChange: () => { queuedOwnerChange = true },
    setMaxBytes: (value: number) => { options.maxBytes = value },
    restart: async () => {
      const restarted = new CodingSessionLibrary(options)
      restarted.register(provider); await restarted.discover(source)
      return restarted
    },
    set: (value: CodingSessionSnapshot) => { history = value }, onRead: (callback: () => void) => { onRead = callback },
    failJournal: () => { writesFail = true }, nativeEffects: () => nativeEffects }
}

describe('restart recovery of cooperative native ownership', () => {
  it('reconstructs a zero-dispatch checkpoint without claiming old process release', async () => {
    const f = await fixture()
    const recovered = await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    expect(recovered.source).toEqual(source)
    expect(recovered.handoff?.phase).toBe('recovered-acknowledged')
    expect(recovered.handoff?.recoveryHistory?.[0]).toMatchObject({ ownerToken: f.oldOwner, previousPhase: 'y-owned',
      dispatchedTurnCount: 0, nativeTurnIds: [], unresolvedDispatchCount: 0, oldProcessExit: 'not-observed',
      oldStreamsDrain: 'not-observed', nativePersistence: 'not-established', historyChange: 'unchanged' })
    expect(f.nativeEffects()).toBe(0)
    expect(codingSessionHandoffSchema.parse(f.markers.get(f.mirror.id))).toEqual(f.markers.get(f.mirror.id))
    await expect(f.library.releaseSequential(f.mirror.id)).rejects.toThrow(/original process|release evidence/)
    await f.library.close()
  })
  it('requires explicit acknowledgement of an admitted turn whose native receipt was lost', async () => {
    const f = await fixture(1)
    await expect(f.library.recoverSequential(f.mirror.id, f.acknowledgement())).rejects.toThrow(/unresolved|unrecorded/)
    expect(f.markers.get(f.mirror.id)?.phase).toBe('blocked-uncertain')
    const recovered = await f.library.recoverSequential(f.mirror.id, { ...f.acknowledgement(), acceptUnresolvedTurns: true })
    expect(recovered.handoff?.recoveryHistory?.[0]).toMatchObject({ dispatchedTurnCount: 1, nativeTurnIds: [],
      unresolvedDispatchCount: 1, acceptedUnresolvedTurns: true, nativePersistence: 'not-established' })
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it('retains native turn IDs as observations without certifying their persistence', async () => {
    const f = await fixture(1, ['original-turn-1'])
    const recovered = await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    expect(recovered.handoff?.recoveryHistory?.[0]).toMatchObject({ nativeTurnIds: ['original-turn-1'], unresolvedDispatchCount: 0,
      nativePersistence: 'not-established', oldProcessExit: 'not-observed' })
    await f.library.close()
  })
  it('retains an appended cold history and starts a separate owner only after a new claim', async () => {
    const f = await fixture()
    f.set({ ...initial, cursor: 'cursor-2', events: [...initial.events,
      { id: brandString<CodingSessionSnapshot['events'][number]['id']>('native-event-2'), role: 'assistant', text: 'Saved native result', digest: 'payload-2' }] })
    const recovered = await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    expect(recovered.events.map(event => event.text)).toEqual(['Original request', 'Saved native result'])
    expect(recovered.revision).toBe(2)
    expect(recovered.handoff?.recoveryHistory?.[0]).toMatchObject({ historyChange: 'appended', previousCursor: 'cursor-1', sourceCursor: 'cursor-2' })
    expect(f.nativeEffects()).toBe(0)
    const claimed = await f.library.claimSequential(recovered.id, { source, project: '/fixture/project', expectedRevision: recovered.revision,
      executionSessionId: brandString<CodingSessionHandoff['executionSessionId']>('new-y-root'), externalWritersClosed: true, nativeProfileUnchanged: true })
    expect(claimed.handoff?.ownerToken).not.toBe(f.oldOwner)
    expect(claimed.handoff?.recoveryHistory).toEqual(recovered.handoff?.recoveryHistory)
    expect(claimed.handoff?.dispatchedTurnCount).toBe(0)
    expect(f.nativeEffects()).toBe(1); await f.library.close()
  })
  it('preserves divergent retained history and leaves recovery blocked', async () => {
    const f = await fixture()
    f.set({ ...initial, cursor: 'edited', events: [{ ...initial.events[0]!, text: 'Changed prompt', digest: 'changed-payload' }] })
    const conflict = await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    expect(conflict.status).toBe('conflict')
    expect(conflict.events[0]?.text).toBe('Original request')
    expect(conflict.handoff?.phase).toBe('blocked-uncertain')
    expect(conflict.handoff?.recoveryHistory).toBeUndefined()
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it('allows fresh review after the source restores the retained divergent prefix', async () => {
    const f = await fixture()
    f.set({ ...initial, cursor: 'edited', events: [{ ...initial.events[0]!, text: 'Changed prompt', digest: 'changed-payload' }] })
    const conflict = await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    expect(conflict.status).toBe('conflict')
    f.set(structuredClone(initial))
    const recovered = await f.library.recoverSequential(f.mirror.id, { ...f.acknowledgement(), expectedRevision: conflict.revision })
    expect(recovered.status).toBe('ready')
    expect(recovered.revision).toBe(3)
    expect(recovered.events[0]?.text).toBe('Original request')
    expect(recovered.handoff?.phase).toBe('recovered-acknowledged')
    expect(recovered.handoff?.recoveryHistory?.[0]).toMatchObject({ reviewedRevision: 2, sourceRevision: 3, historyChange: 'unchanged' })
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it.each([
    { externalWritersClosed: false }, { nativeProfileUnchanged: false }, { project: '/other/project' },
    { expectedRevision: 99 }, { expectedOwnerToken: brandString<CodingSessionHandoff['ownerToken']>('other-owner') },
    { source: { ...source, nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('other-native-id') } },
  ])('refuses changed review or weaker acknowledgements %j', async (change) => {
    const f = await fixture()
    await expect(f.library.recoverSequential(f.mirror.id, { ...f.acknowledgement(), ...change })).rejects.toThrow()
    expect(f.markers.get(f.mirror.id)?.phase).toBe('blocked-uncertain')
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it.each([{ ...initial, cwd: '/other/project' }, { ...initial, writerState: 'active' as const },
    { ...initial, source: { ...source, nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('other-native-id') } }])(
    'refuses cold source, project or active writer changes', async (history) => {
      const f = await fixture(); f.set(history)
      await expect(f.library.recoverSequential(f.mirror.id, f.acknowledgement())).rejects.toThrow()
      expect(f.markers.get(f.mirror.id)?.phase).toBe('blocked-uncertain')
      expect(f.nativeEffects()).toBe(0); await f.library.close()
    })
  it('cannot discard a live owned handle through restart recovery', async () => {
    const f = await fixture()
    const recovered = await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    const claimed = await f.library.claimSequential(recovered.id, { source, project: '/fixture/project', expectedRevision: recovered.revision,
      executionSessionId: brandString<CodingSessionHandoff['executionSessionId']>('live-y-root'), externalWritersClosed: true, nativeProfileUnchanged: true })
    await expect(f.library.recoverSequential(claimed.id, { ...f.acknowledgement(), expectedRevision: claimed.revision,
      expectedOwnerToken: claimed.handoff!.ownerToken })).rejects.toThrow(/live|retained|release/)
    expect((await f.library.detail(claimed.id)).handoff?.phase).toBe('y-owned')
    expect(f.nativeEffects()).toBe(1); await f.library.close()
  })
  it('does not expose a recovered checkpoint before its journal write commits', async () => {
    const f = await fixture(); f.failJournal()
    await expect(f.library.recoverSequential(f.mirror.id, f.acknowledgement())).rejects.toThrow('Journal unavailable')
    expect((await f.library.detail(f.mirror.id)).handoff?.phase).toBe('blocked-uncertain')
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it('recovers through a reader with both sequential execution opt-ins unavailable', async () => {
    const f = await fixture(0, [], false); delete f.provider.sequentialWriter
    const recovered = await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    expect(recovered.handoff?.phase).toBe('recovered-acknowledged')
    expect(recovered.sequentialAvailable).toBe(false)
    await expect(f.library.claimSequential(recovered.id, { source, project: '/fixture/project', expectedRevision: recovered.revision,
      executionSessionId: brandString<CodingSessionHandoff['executionSessionId']>('new-y-root'), externalWritersClosed: true,
      nativeProfileUnchanged: true })).rejects.toThrow('disabled')
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it('does not overwrite a concurrent ownership marker change during the cold read', async () => {
    const f = await fixture()
    f.onRead(() => { f.markers.set(f.mirror.id, { ...f.markers.get(f.mirror.id)!, ownerToken: brandString<CodingSessionHandoff['ownerToken']>('newer-owner') }) })
    await expect(f.library.recoverSequential(f.mirror.id, f.acknowledgement())).rejects.toThrow(/ownership.*changed|marker.*changed/)
    expect(f.markers.get(f.mirror.id)?.ownerToken).toBe('newer-owner')
    expect(f.markers.get(f.mirror.id)?.recoveryHistory).toBeUndefined()
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it('preserves a reviewed recovery checkpoint across a second Host restart', async () => {
    const f = await fixture()
    await f.library.recoverSequential(f.mirror.id, f.acknowledgement())
    await f.library.close()
    const restarted = await f.restart()
    expect((await restarted.detail(f.mirror.id)).handoff?.phase).toBe('recovered-acknowledged')
    const retained = f.markers.get(f.mirror.id)!
    expect(retained.phase).toBe('recovered-acknowledged')
    expect(retained.recoveryHistory?.[0]?.ownerToken).toBe(f.oldOwner)
    expect(codingSessionHandoffSchema.parse(retained)).toEqual(retained)
    await restarted.close()
  })
  it('does not overwrite a newer owner queued ahead of checkpoint publication', async () => {
    const f = await fixture(); f.queueOwnerChange()
    await expect(f.library.recoverSequential(f.mirror.id, f.acknowledgement())).rejects.toThrow(/ownership.*changed|marker.*changed/)
    expect(f.markers.get(f.mirror.id)?.ownerToken).toBe('queued-new-owner')
    expect(f.markers.get(f.mirror.id)?.phase).toBe('blocked-uncertain')
    expect(f.markers.get(f.mirror.id)?.recoveryHistory).toBeUndefined()
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it('refuses recovery if the ownership store cannot atomically compare its current marker', async () => {
    const f = await fixture(); Reflect.deleteProperty(f.handoffStore, 'update')
    await expect(f.library.recoverSequential(f.mirror.id, f.acknowledgement())).rejects.toThrow(/atomic|ownership.*storage/)
    expect(f.markers.get(f.mirror.id)?.phase).toBe('blocked-uncertain')
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
  it('bounds complete multibyte mirror detail including its retained ownership marker', async () => {
    const f = await fixture()
    const title = '界'.repeat(1000)
    f.records.set(f.mirror.id, { ...f.records.get(f.mirror.id)!, title })
    const completeBytes = Buffer.byteLength(JSON.stringify(await f.library.detail(f.mirror.id)), 'utf8')
    f.setMaxBytes(completeBytes)
    expect(Buffer.byteLength(JSON.stringify(await f.library.detail(f.mirror.id)), 'utf8')).toBe(completeBytes)
    f.setMaxBytes(completeBytes - 1)
    await expect(f.library.detail(f.mirror.id)).rejects.toThrow(/complete|framed|byte limit/)
    expect(f.markers.get(f.mirror.id)?.phase).toBe('blocked-uncertain')
    await f.library.close()
  })
  it('refuses an oversized complete recovery result before committing its checkpoint', async () => {
    const f = await fixture()
    const title = '界'.repeat(1000)
    f.records.set(f.mirror.id, { ...f.records.get(f.mirror.id)!, title }); f.set({ ...initial, title })
    const currentBytes = Buffer.byteLength(JSON.stringify(await f.library.detail(f.mirror.id)), 'utf8')
    f.setMaxBytes(currentBytes + 10)
    await expect(f.library.recoverSequential(f.mirror.id, f.acknowledgement())).rejects.toThrow(/complete|framed|byte limit/)
    expect(f.markers.get(f.mirror.id)?.phase).toBe('blocked-uncertain')
    expect(f.markers.get(f.mirror.id)?.recoveryHistory).toBeUndefined()
    expect(f.nativeEffects()).toBe(0); await f.library.close()
  })
})
