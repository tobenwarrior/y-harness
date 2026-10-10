/** Explicit sequential ownership fixtures never launch native processes or model requests. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CodingSessionLibrary } from '../src/library.ts'
import type { CodingSessionClaimAcknowledgement, CodingSessionNativeTurnId, CodingSessionHandoff, CodingSessionMirror, CodingSessionProvider, CodingSessionSnapshot } from '../src/types.ts'

const source: CodingSessionSnapshot['source'] = { provider: 'codex', profileId: brandString<CodingSessionSnapshot['source']['profileId']>('original-profile'), nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('original-native-id') }
const initial: CodingSessionSnapshot = { source, title: 'Original work', cwd: '/fixture/project', writerState: 'unknown', cursor: 'cursor-1', events: [{ id: brandString<CodingSessionSnapshot['events'][number]['id']>('event-1'), role: 'user', text: 'Original prompt', digest: 'digest-1' }] }
function fixture(enabled = true) {
  const records = new Map<CodingSessionMirror['id'], CodingSessionMirror>()
  const markers = new Map<CodingSessionMirror['id'], CodingSessionHandoff>()
  let history = structuredClone(initial)
  let acquisitions = 0; let resumed = 0; let releases = 0; let releaseFailure = false; let journalFailure = false
  const provider: CodingSessionProvider = { provider: 'codex', profileId: source.profileId, label: 'Selected original source', connected: () => true,
    discover: async () => ({ items: [history] }), read: async () => structuredClone(history),
    sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: 'conversation', acquire: async (selected) => {
      acquisitions++
      return { source: selected, read: async () => structuredClone(history), resumeOriginal: async (request) => {
        await request.beforeDispatch(); resumed++; expect(request.source).toEqual(source)
        history = { ...history, cursor: `cursor-${resumed + 1}`, events: [...history.events, { id: brandString<CodingSessionSnapshot['events'][number]['id']>(`event-${resumed + 1}`), role: 'assistant', text: request.text, digest: `digest-${resumed + 1}` }] }
        return { nativeTurnId: brandString<CodingSessionNativeTurnId>(`native-turn-${resumed}`) }
      }, release: async () => {
        releases++; if (releaseFailure) throw new Error('Persistence unconfirmed')
        return { source, snapshot: structuredClone(history), processExited: true, streamsDrained: true, expectedPrefixPersisted: true, completedTurnPersisted: resumed > 0, nativeTurnIds: Array.from({ length: resumed }, (_, index) => brandString<CodingSessionNativeTurnId>(`native-turn-${index + 1}`)), noObservedPersistenceErrors: true }
      } }
    } },
  }
  const library = new CodingSessionLibrary({ store: { get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => { records.set(id, structuredClone(value)) } }, pageSize: 20, maxEvents: 50, maxMirrors: 50, maxBytes: 10000, timeoutMs: 1000, enableSequentialHandoff: enabled, handoffStore: { get: id => markers.get(id), entries: () => markers.entries(), put: async (id, marker) => { if (journalFailure && marker.phase === 'releasing') throw new Error('Journal failed'); markers.set(id, structuredClone(marker)) } } })
  const unregister = library.register(provider)
  const acknowledgement = (mirror: CodingSessionMirror): CodingSessionClaimAcknowledgement => ({ source: mirror.source, project: '/fixture/project', expectedRevision: mirror.revision, externalWritersClosed: true, nativeProfileUnchanged: true, executionSessionId: brandString<CodingSessionClaimAcknowledgement['executionSessionId']>('selected-y-root') })
  return { library, records, markers, provider, unregister, acknowledgement,
    set: (value: CodingSessionSnapshot) => { history = value },
    failRelease: (value: boolean) => { releaseFailure = value },
    failJournal: (value: boolean) => { journalFailure = value }, counts: () => ({ acquisitions, resumed, releases }),
  }
}
describe('explicit sequential native session handoff', () => {
  it('stays opted out and preserves the stronger exclusive writer admission', async () => {
    const f = fixture(false); const mirror = await f.library.importSession(source)
    expect(mirror.sequentialAvailable).toBe(false)
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('disabled')
    await expect(f.library.continueSession(mirror.id, 'Strong continuation', mirror.revision)).rejects.toThrow('exclusive native writer')
    expect(f.counts()).toEqual({ acquisitions: 0, resumed: 0, releases: 0 }); await f.library.close()
  })
  it('claims exact original identity, continues under held ownership and releases for the native app', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    const claimed = await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    expect(claimed.handoff).toMatchObject({ phase: 'y-owned', source, project: '/fixture/project' })
    expect(f.records.get(mirror.id)).not.toHaveProperty('handoff')
    const continued = await f.library.continueSequential(mirror.id, 'Continue original work', claimed.revision)
    expect(continued.events.map(event => event.text)).toEqual(['Original prompt', 'Continue original work'])
    expect(continued.source).toEqual(source); expect(continued.handoff?.phase).toBe('y-owned')
    expect((await f.library.releaseSequential(mirror.id)).handoff?.phase).toBe('external-ready')
    expect(f.counts()).toEqual({ acquisitions: 1, resumed: 1, releases: 1 }); await f.library.close()
  })
  it('requires the exact profile, project, revision and explicit prior-writer acknowledgement before acquisition', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source); const ack = f.acknowledgement(mirror)
    for (const invalid of [{ ...ack, externalWritersClosed: false }, { ...ack, nativeProfileUnchanged: false }, { ...ack, expectedRevision: 99 }, { ...ack, project: '/other/project' }, { ...ack, source: { ...source, profileId: brandString<CodingSessionSnapshot['source']['profileId']>('other-profile') } }]) {
      await expect(f.library.claimSequential(mirror.id, invalid)).rejects.toThrow()
    }
    expect(f.counts().acquisitions).toBe(0); await f.library.close()
  })
  it.each(['externalWritersClosed', 'nativeProfileUnchanged'].flatMap(field =>
    [undefined, 1, 'false', {}, []].map(value => ({ field, value }))))(
    'refuses malformed $field acknowledgement before acquiring a writer', async ({ field, value }) => {
      const f = fixture(); const mirror = await f.library.importSession(source)
      const acknowledgement = f.acknowledgement(mirror)
      // Corrupt only the runtime boundary; public acknowledgement types stay unchanged.
      if (value === undefined) Reflect.deleteProperty(acknowledgement, field)
      else Reflect.set(acknowledgement, field, value)
      try {
        await expect(f.library.claimSequential(mirror.id, acknowledgement)).rejects.toThrow('close its previous native writer')
        expect(f.counts()).toEqual({ acquisitions: 0, resumed: 0, releases: 0 })
        expect(f.markers.size).toBe(0)
        expect(await f.library.detail(mirror.id)).toMatchObject({ source, events: mirror.events, revision: mirror.revision })
      } finally { await f.library.close() }
    },
  )
  it('releases a stale cold acquisition without dispatching or replacing retained history', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    f.set({ ...initial, cursor: 'externally-appended', events: [...initial.events, { id: brandString<CodingSessionSnapshot['events'][number]['id']>('outside-event'), role: 'assistant', text: 'Native app changed', digest: 'outside' }] })
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('Refresh')
    expect(f.counts()).toEqual({ acquisitions: 1, resumed: 0, releases: 1 })
    const retained = await f.library.detail(mirror.id)
    expect(retained.events.slice(0, mirror.events.length)).toEqual(mirror.events)
    expect(retained.events.map(event => event.text)).toEqual(['Original prompt', 'Native app changed'])
    expect(retained.revision).toBeGreaterThan(mirror.revision)
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('changed')
    expect(f.counts().acquisitions).toBe(1); await f.library.close()
  })
  it('detects intervening native history before another turn and blocks further continuation until release', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    f.set({ ...initial, cursor: 'outside-change' })
    await expect(f.library.continueSequential(mirror.id, 'Do not dispatch', mirror.revision)).rejects.toThrow('Refresh')
    expect(f.counts().resumed).toBe(0)
    expect((await f.library.detail(mirror.id)).handoff?.phase).toBe('blocked-uncertain')
    await f.library.releaseSequential(mirror.id); await f.library.close()
  })
  it('retains uncertain ownership after a release failure and lets explicit retry establish readiness', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); f.failRelease(true)
    await expect(f.library.releaseSequential(mirror.id)).rejects.toThrow('Persistence')
    expect((await f.library.detail(mirror.id)).handoff?.phase).toBe('blocked-uncertain')
    await expect(f.library.continueSequential(mirror.id, 'Do not dispatch', mirror.revision)).rejects.toThrow('ownership')
    f.failRelease(false); expect((await f.library.releaseSequential(mirror.id)).handoff?.phase).toBe('external-ready')
    await f.library.close()
  })
  it.each(['processExited', 'streamsDrained', 'expectedPrefixPersisted', 'noObservedPersistenceErrors']
    .flatMap(field => [{ field, missing: false }, { field, missing: true }]))(
    'retains uncertain ownership when native release evidence $field is missing=$missing', async ({ field, missing }) => {
      const f = fixture(); const mirror = await f.library.importSession(source)
      const writer = f.provider.sequentialWriter
      if (writer === undefined) throw new Error('Fixture sequential writer is absent')
      const damage = { enabled: true }
      f.provider.sequentialWriter = { ...writer, acquire: async (selected, request) => {
        const lease = await writer.acquire(selected, request)
        return { ...lease, release: async (limits) => {
          const receipt = await lease.release(limits)
          // Reflect models a damaged runtime adapter response without a cast to the public literal evidence type.
          if (damage.enabled) {
            if (missing) Reflect.deleteProperty(receipt, field)
            else Reflect.set(receipt, field, false)
          }
          return receipt
        } }
      } }
      await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
      await expect(f.library.releaseSequential(mirror.id)).rejects.toThrow()
      const retained = await f.library.detail(mirror.id)
      expect(retained).toMatchObject({ source, events: mirror.events, cursor: mirror.cursor, revision: mirror.revision })
      expect(retained.handoff?.phase).toBe('blocked-uncertain')
      expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain')
      await expect(f.library.claimSequential(mirror.id, f.acknowledgement(retained))).rejects.toThrow('ownership')
      expect(f.counts()).toEqual({ acquisitions: 1, resumed: 0, releases: 1 })
      damage.enabled = false
      await f.library.releaseSequential(mirror.id); await f.library.close()
    },
  )
  it('does not declare release before the actual adapter quiescence barrier resolves', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    let settle!: () => void; let entered!: () => void
    const entering = new Promise<void>((done) => { entered = done })
    f.provider.sequentialWriter = { authority: 'user-acknowledged-sequential', toolMode: 'conversation',
      acquire: async selected => ({ source: selected, read: async () => initial,
        resumeOriginal: async () => ({ nativeTurnId: brandString<CodingSessionNativeTurnId>('unused-turn') }),
        release: async () => {
          entered(); await new Promise<void>((done) => { settle = done })
          return { source, snapshot: initial, processExited: true, streamsDrained: true, expectedPrefixPersisted: true,
            completedTurnPersisted: false, nativeTurnIds: [], noObservedPersistenceErrors: true }
        },
      }),
    }
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    let released = false; const pending = f.library.releaseSequential(mirror.id).then(() => { released = true })
    await entering
    try {
      expect(released).toBe(false); expect((await f.library.detail(mirror.id)).handoff?.phase).toBe('releasing')
    } finally { settle(); await pending }
    expect((await f.library.detail(mirror.id)).handoff?.phase).toBe('external-ready'); await f.library.close()
  })
  it('cancels and drains active work before releasing all held original writers', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    await f.library.cancelPending()
    expect((await f.library.detail(mirror.id)).handoff?.phase).toBe('external-ready')
    expect(f.counts().releases).toBe(1); await f.library.close()
  })
  it('releases removed provider ownership without requiring a reconnected read source', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); await f.unregister()
    await f.library.cancelPending()
    expect(f.counts().releases).toBe(1)
    expect((await f.library.detail(mirror.id)).capabilities.refresh).toBe(false); await f.library.close()
  })
  it('retains an unresolved ownership marker across a new library instance without inventing a recovered process handle', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    const reopened = new CodingSessionLibrary({
      store: { get: id => f.records.get(id), entries: () => f.records.entries(),
        put: async (id, value) => { f.records.set(id, value) } },
      handoffStore: { get: id => f.markers.get(id), entries: () => f.markers.entries(),
        put: async (id, value) => { f.markers.set(id, value) } },
      pageSize: 20, maxEvents: 50, maxMirrors: 50, maxBytes: 10000, timeoutMs: 1000, enableSequentialHandoff: true,
    })
    reopened.register(f.provider)
    expect((await reopened.detail(mirror.id)).handoff?.phase).toBe('blocked-uncertain')
    await expect(reopened.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('ownership')
    await expect(reopened.releaseSequential(mirror.id)).rejects.toThrow('process handle')
    await expect(reopened.continueSession(mirror.id, 'Do not use strong fallback', mirror.revision)).rejects.toThrow('sequential ownership')
    expect(f.counts().acquisitions).toBe(1)
    await reopened.close(); await f.library.releaseSequential(mirror.id); await f.library.close()
  })

  it('attempts every held process release when one writer cannot confirm persistence', async () => {
    const f = fixture(); const first = await f.library.importSession(source)
    await f.library.claimSequential(first.id, f.acknowledgement(first))
    const otherSource: CodingSessionSnapshot['source'] = { ...source, profileId: brandString<CodingSessionSnapshot['source']['profileId']>('other-profile') }
    const other = { ...initial, source: otherSource }; let otherReleases = 0
    f.library.register({ ...f.provider, profileId: otherSource.profileId, read: async () => other,
      sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: 'conversation', acquire: async selected => ({ source: selected, read: async () => other,
        resumeOriginal: async (request) => {
          await request.beforeDispatch(); return { nativeTurnId: brandString<CodingSessionNativeTurnId>('unused-turn') }
        },
        release: async () => {
          otherReleases++
          return { source: otherSource, snapshot: other, processExited: true, streamsDrained: true,
            expectedPrefixPersisted: true, completedTurnPersisted: false, nativeTurnIds: [], noObservedPersistenceErrors: true }
        },
      }) },
    })
    const second = await f.library.importSession(otherSource)
    await f.library.claimSequential(second.id, { ...f.acknowledgement(second), source: otherSource })
    f.failRelease(true)
    await expect(f.library.cancelPending()).rejects.toThrow('release remains uncertain')
    expect(f.counts().releases).toBe(1); expect(otherReleases).toBe(1)
    expect((await f.library.detail(first.id)).handoff?.phase).toBe('blocked-uncertain')
    expect((await f.library.detail(second.id)).handoff?.phase).toBe('external-ready')
    f.failRelease(false); await f.library.close()
  })
  it('still drains the native process when publishing the releasing journal phase fails', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); f.failJournal(true)
    await expect(f.library.releaseSequential(mirror.id)).rejects.toThrow('Journal failed')
    expect(f.counts().releases).toBe(1)
    expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain')
    f.failJournal(false); await f.library.releaseSequential(mirror.id); await f.library.close()
  })
  it('rejects an adapter that skips durable turn admission and does not report a completed turn', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    f.provider.sequentialWriter = { authority: 'user-acknowledged-sequential', toolMode: 'conversation', acquire: async selected => ({ source: selected, read: async () => initial,
      resumeOriginal: async () => ({ nativeTurnId: brandString<CodingSessionNativeTurnId>('invalid-unadmitted-turn') }),
      release: async () => ({ source, snapshot: initial, processExited: true, streamsDrained: true, expectedPrefixPersisted: true,
        completedTurnPersisted: false, nativeTurnIds: [], noObservedPersistenceErrors: true }),
    }) }
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    await expect(f.library.continueSequential(mirror.id, 'Do not accept missing admission', mirror.revision)).rejects.toThrow('durable admission')
    expect(f.markers.get(mirror.id)?.dispatchedTurnCount).toBe(0)
    await f.library.releaseSequential(mirror.id); await f.library.close()
  })

})
