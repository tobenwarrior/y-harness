/** Synthetic native capabilities exercise refusal, durable publication and retained-owner teardown. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CodingSessionLibrary } from '../src/library.ts'
import type {
  CodingSessionClaimAcknowledgement, CodingSessionHandoff, CodingSessionLibraryOptions, CodingSessionMirror,
  CodingSessionNativeTurnId, CodingSessionProvider, CodingSessionSequentialReleaseReceipt, CodingSessionSnapshot,
} from '../src/types.ts'

const source: CodingSessionSnapshot['source'] = { provider: 'codex',
  profileId: brandString<CodingSessionSnapshot['source']['profileId']>('lifecycle-profile'),
  nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('lifecycle-original') }
const initial: CodingSessionSnapshot = { source, title: 'Synthetic native work', cwd: '/fixture/project',
  writerState: 'idle', cursor: 'cursor-1', events: [{
    id: brandString<CodingSessionSnapshot['events'][number]['id']>('event-1'), role: 'user', text: 'Fixture text', digest: 'digest-1',
  }] }
const turnId = brandString<CodingSessionNativeTurnId>('fixture-turn')

function fixture(overrides: Partial<CodingSessionLibraryOptions> = {}) {
  const records = new Map<CodingSessionMirror['id'], CodingSessionMirror>()
  const markers = new Map<CodingSessionMirror['id'], CodingSessionHandoff>()
  let history = structuredClone(initial)
  let releaseChange: (receipt: CodingSessionSequentialReleaseReceipt) => CodingSessionSequentialReleaseReceipt = value => value
  const counts = { acquisitions: 0, dispatches: 0, releases: 0 }
  const options: CodingSessionLibraryOptions = { pageSize: 10, maxEvents: 50, maxMirrors: 50,
    maxBytes: 100000, timeoutMs: 1000, enableSequentialHandoff: true,
    store: { get: id => records.get(id), entries: () => records.entries(),
      put: async (id, value) => { records.set(id, structuredClone(value)) } },
    handoffStore: { get: id => markers.get(id), entries: () => markers.entries(),
      put: async (id, value) => { markers.set(id, structuredClone(value)) },
      update: async (id, change) => {
        const retained = markers.get(id)
        if (retained === undefined) throw new Error('Fixture marker disappeared')
        const next = structuredClone(change(retained)); markers.set(id, next); return next
      } }, ...overrides }
  const provider: CodingSessionProvider = { ...source, label: 'Synthetic source', connected: () => true,
    discover: async () => ({ items: [history] }), read: async () => structuredClone(history),
    sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: 'conversation', acquire: async (selected) => {
      counts.acquisitions++
      return { source: selected, read: async () => structuredClone(history), resumeOriginal: async (request) => {
        await request.beforeDispatch(); counts.dispatches++
        return { nativeTurnId: turnId }
      }, release: async () => {
        counts.releases++
        return releaseChange({ source, snapshot: structuredClone(history), processExited: true, streamsDrained: true,
          expectedPrefixPersisted: true, completedTurnPersisted: counts.dispatches > 0,
          nativeTurnIds: counts.dispatches === 0 ? [] : [turnId], noObservedPersistenceErrors: true })
      } }
    } } }
  const library = new CodingSessionLibrary(options)
  const unregister = library.register(provider)
  onTestFinished(async () => { releaseChange = value => value; await library.close() })
  const acknowledgement = (mirror: CodingSessionMirror): CodingSessionClaimAcknowledgement => ({ source,
    project: '/fixture/project', expectedRevision: mirror.revision, externalWritersClosed: true, nativeProfileUnchanged: true,
    executionSessionId: brandString<CodingSessionClaimAcknowledgement['executionSessionId']>('fixture-y-root') })
  return { library, provider, options, records, markers, counts, unregister, acknowledgement,
    set: (value: CodingSessionSnapshot) => { history = value },
    setRelease: (change: typeof releaseChange) => { releaseChange = change },
  }
}

describe('coding-session library admission and lifecycle gaps', () => {
  it('requires durable ownership storage before enabling sequential handoff', () => {
    expect(() => new CodingSessionLibrary({ pageSize: 1, maxEvents: 1, maxBytes: 1000, maxMirrors: 1, timeoutMs: 100,
      enableSequentialHandoff: true, store: { get: () => undefined, entries: () => new Map<CodingSessionMirror['id'], CodingSessionMirror>().entries(), put: async () => {} },
    })).toThrow('requires durable ownership storage')
  })
  it('refuses duplicate profiles and keeps disposer identity stable after close', async () => {
    const f = fixture()
    expect(() => f.library.register(f.provider)).toThrow('already registered')
    await f.library.close()
    const first = f.unregister(); expect(f.unregister()).toBe(first); await first
  })
  it('refuses an overfull retained inventory without discarding any mirror', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    f.options.maxMirrors = 0
    expect(() => f.library.state()).toThrow('mirror count limit')
    expect(f.records.get(mirror.id)?.events).toEqual(initial.events)
  })
  it.each(['item-count', 'framed-bytes', 'foreign-profile'])('refuses %s discovery before returning a page', async (mode) => {
    const f = fixture()
    f.provider.discover = async () => ({ items: mode === 'item-count' ? Array.from({ length: 11 }, () => initial)
      : mode === 'framed-bytes' ? [{ ...initial, title: 'x'.repeat(100001) }]
        : [{ ...initial, source: { ...source, profileId: brandString<CodingSessionSnapshot['source']['profileId']>('foreign') } }] })
    await expect(f.library.discover(source)).rejects.toThrow(mode === 'foreign-profile' ? 'identity' : 'limit')
    expect(f.records.size).toBe(0)
  })
  it('refuses contradictory first delivery and retains repeated later conflicts exactly', async () => {
    const f = fixture(); f.set({ ...initial, events: [...initial.events, { ...initial.events[0]!, digest: 'contradiction' }] })
    await expect(f.library.importSession(source)).rejects.toThrow('conflicting event identities'); expect(f.records.size).toBe(0)
    f.set(initial); const mirror = await f.library.importSession(source); f.set({ ...initial, events: [] })
    const conflict = await f.library.refreshMirror(mirror.id)
    expect(await f.library.refreshMirror(mirror.id)).toEqual(conflict)
    expect(conflict.events).toEqual(initial.events); expect(conflict.revision).toBe(2)
  })
  it('refuses an oversized conflict receipt without replacing retained ready history', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    const conflict = { ...f.records.get(mirror.id)!, status: 'conflict', conflict: 'history-diverged', revision: 2 }
    f.options.maxBytes = Buffer.byteLength(JSON.stringify(conflict)) - 1
    f.set({ ...initial, events: [] })
    await expect(f.library.importSession(source)).rejects.toThrow('framed byte limit')
    expect(f.records.get(mirror.id)?.status).toBe('ready'); expect(f.records.get(mirror.id)?.revision).toBe(1)
  })
  it('bounds the complete first mirror even when the native snapshot fits', async () => {
    const f = fixture({ maxBytes: Buffer.byteLength(JSON.stringify(initial)) + 1 })
    await expect(f.library.importSession(source)).rejects.toThrow('mirror exceeded the complete framed byte limit')
    expect(f.records.size).toBe(0)
  })
  it('refuses detail for an unretained exact mirror identity', async () => {
    const f = fixture()
    await expect(f.library.detail(brandString<CodingSessionMirror['id']>('missing'))).rejects.toThrow('not found')
  })
  it('refuses claim before journal publication when no sequential writer is available', async () => {
    const f = fixture(); delete f.provider.sequentialWriter
    const mirror = await f.library.importSession(source)
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('does not support sequential handoff')
    expect(f.markers.size).toBe(0)
  })
  it('durably blocks a failed acquisition and refuses both source refresh and repeated claim', async () => {
    const f = fixture(); f.provider.sequentialWriter = { authority: 'user-acknowledged-sequential', toolMode: 'conversation',
      acquire: async () => { f.counts.acquisitions++; throw new Error('Synthetic acquisition failure') } }
    const mirror = await f.library.importSession(source)
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('Synthetic acquisition failure')
    expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain')
    await expect(f.library.refreshMirror(mirror.id)).rejects.toThrow('unresolved')
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('ownership')
    expect(f.counts.acquisitions).toBe(1)
  })
  it('releases a foreign acquisition without accepting ownership of a replacement original', async () => {
    const f = fixture(); const writer = f.provider.sequentialWriter!
    f.provider.sequentialWriter = { ...writer, acquire: async (selected, request) => ({
      ...await writer.acquire(selected, request),
      source: { ...source, nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('foreign-original') },
    }) }
    const mirror = await f.library.importSession(source)
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('selected original source')
    expect(f.counts).toEqual({ acquisitions: 1, dispatches: 0, releases: 1 })
    expect(f.markers.get(mirror.id)?.phase).toBe('external-ready')
  })
  it('refuses an oversized ownership marker before acquisition', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await expect(f.library.claimSequential(mirror.id, { ...f.acknowledgement(mirror),
      executionSessionId: brandString<CodingSessionClaimAcknowledgement['executionSessionId']>('x'.repeat(100001)),
    })).rejects.toThrow('ownership exceeded')
    expect(f.counts.acquisitions).toBe(0); expect(f.markers.size).toBe(0)
  })
  it('refuses claim when the deployment withdraws its optional ownership store', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source); const ownership = f.options.handoffStore!
    delete f.options.handoffStore
    try {
      await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('storage is not available')
      expect(f.counts.acquisitions).toBe(0); expect(f.markers.size).toBe(0)
    } finally { f.options.handoffStore = ownership }
  })
  it('refuses an oversized retained ownership inventory during cold startup', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); await f.library.releaseSequential(mirror.id)
    await f.library.close()
    const restarted = new CodingSessionLibrary({ ...f.options, maxMirrors: 0 })
    await expect(restarted.importSession(source)).rejects.toThrow('configured marker limit')
    await restarted.close()
    expect(f.markers.get(mirror.id)?.phase).toBe('external-ready')
  })
  it('keeps exclusive writer capability gated by a lost unrecovered marker', async () => {
    const f = fixture(); f.provider.writer = { authority: 'native-enforced-exclusion',
      acquire: async () => { throw new Error('A lost sequential owner must prevent this acquisition') } }
    const mirror = await f.library.importSession(source)
    f.provider.sequentialWriter = { authority: 'user-acknowledged-sequential', toolMode: 'conversation',
      acquire: async () => { throw new Error('Synthetic lost owner') } }
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('Synthetic lost owner')
    expect((await f.library.detail(mirror.id)).capabilities.continue).toBe(false)
    await expect(f.library.continueSession(mirror.id, 'Synthetic text', 1)).rejects.toThrow('Release sequential ownership')
    expect(f.counts.dispatches).toBe(0)
  })
  it('uses the retained lease for refresh and refuses refresh during uncertain ownership', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    f.provider.read = async () => { throw new Error('Cold reader must not replace the live lease') }
    expect((await f.library.refreshMirror(mirror.id)).revision).toBe(1)
    f.set({ ...initial, cursor: 'outside-change' })
    await expect(f.library.continueSequential(mirror.id, 'Synthetic text', 1)).rejects.toThrow('Refresh')
    await expect(f.library.refreshMirror(mirror.id)).rejects.toThrow('unresolved')
    f.set(initial); await f.library.releaseSequential(mirror.id)
  })
  it.each(['empty', 'framed-bytes'])('refuses %s sequential text before any dispatch', async (mode) => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await expect(f.library.continueSequential(mirror.id, mode === 'empty' ? ' \n ' : 'x'.repeat(100001), 1)).rejects.toThrow(mode === 'empty' ? 'message' : 'limit')
    expect(f.counts.dispatches).toBe(0); expect(f.markers.size).toBe(0)
  })
  it('refuses repeated durable admission before a native turn can dispatch twice', async () => {
    const f = fixture(); const writer = f.provider.sequentialWriter!
    f.provider.sequentialWriter = { ...writer, acquire: async (selected, request) => {
      const lease = await writer.acquire(selected, request)
      return { ...lease, resumeOriginal: async (resumed) => {
        await resumed.beforeDispatch(); await resumed.beforeDispatch(); return { nativeTurnId: turnId }
      } }
    } }
    const mirror = await f.library.importSession(source); await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    await expect(f.library.continueSequential(mirror.id, 'Synthetic text', 1)).rejects.toThrow('more than once')
    expect(f.markers.get(mirror.id)).toMatchObject({ phase: 'blocked-uncertain', dispatchedTurnCount: 1, nativeTurnIds: [] })
    expect(f.counts.dispatches).toBe(0)
    // A later synthetic release supplies the admission receipt; no real provider ran.
    f.setRelease(value => ({ ...value, completedTurnPersisted: true, nativeTurnIds: [turnId] }))
    await f.library.releaseSequential(mirror.id)
  })
  it('retains a divergence conflict after admitted native continuation', async () => {
    const f = fixture(); const writer = f.provider.sequentialWriter!
    f.provider.sequentialWriter = { ...writer, acquire: async (selected, request) => {
      const lease = await writer.acquire(selected, request)
      return { ...lease, resumeOriginal: async (resumed) => {
        await resumed.beforeDispatch(); f.counts.dispatches++; f.set({ ...initial, events: [] }); return { nativeTurnId: turnId }
      } }
    } }
    const mirror = await f.library.importSession(source); await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    await expect(f.library.continueSequential(mirror.id, 'Synthetic text', 1)).rejects.toThrow('history changed during continuation')
    expect(f.records.get(mirror.id)).toMatchObject({ status: 'conflict', events: initial.events })
    expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain')
    f.set(initial); await f.library.releaseSequential(mirror.id)
  })
  it('enforces the fresh lease history bound before dispatch and releases it afterwards', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); f.options.maxEvents = 0
    await expect(f.library.continueSequential(mirror.id, 'Synthetic text', 1)).rejects.toThrow('history exceeded')
    expect(f.counts.dispatches).toBe(0); f.options.maxEvents = 50; await f.library.releaseSequential(mirror.id)
  })
  it('makes confirmed release idempotent when no retained process remains', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); await f.library.releaseSequential(mirror.id)
    expect((await f.library.releaseSequential(mirror.id)).handoff?.phase).toBe('external-ready')
    expect(f.counts.releases).toBe(1)
  })
  it('imports a confirmed external-ready original through its cold source after restart', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); await f.library.releaseSequential(mirror.id)
    await f.library.close()
    const restarted = new CodingSessionLibrary(f.options); restarted.register(f.provider)
    try {
      const imported = await restarted.importSession(source)
      expect(imported).toMatchObject({ source, revision: 1, handoff: { phase: 'external-ready' }, sequentialReleaseAvailable: false })
      expect(f.counts.acquisitions).toBe(1)
    } finally { await restarted.close() }
  })
  it.each(['absent', 'external-ready'])('refuses recovery of a %s owner without cold-read publication', async (mode) => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    if (mode === 'external-ready') {
      await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); await f.library.releaseSequential(mirror.id)
    }
    await expect(f.library.recoverSequential(mirror.id, { ...f.acknowledgement(mirror),
      expectedOwnerToken: brandString<CodingSessionHandoff['ownerToken']>('unused'), acceptUnresolvedTurns: false,
    })).rejects.toThrow('does not require restart recovery')
    expect(f.records.get(mirror.id)?.revision).toBe(1)
  })
  it.each(['repeated-native-identity', 'changed-retained-mirror'])('refuses %s during cold recovery', async (mode) => {
    const f = fixture(); f.provider.sequentialWriter = { authority: 'user-acknowledged-sequential', toolMode: 'conversation',
      acquire: async () => { throw new Error('Synthetic cold owner') } }
    const mirror = await f.library.importSession(source)
    await expect(f.library.claimSequential(mirror.id, f.acknowledgement(mirror))).rejects.toThrow('Synthetic cold owner')
    const marker = structuredClone(f.markers.get(mirror.id)!)
    f.provider.read = async () => {
      if (mode === 'changed-retained-mirror') f.records.set(mirror.id, { ...f.records.get(mirror.id)!, title: 'Concurrent journal change' })
      return { ...initial, events: mode === 'repeated-native-identity' ? [...initial.events, ...initial.events] : initial.events }
    }
    await expect(f.library.recoverSequential(mirror.id, { ...f.acknowledgement(mirror),
      expectedOwnerToken: marker.ownerToken, acceptUnresolvedTurns: false,
    })).rejects.toThrow(mode === 'repeated-native-identity' ? 'repeated event identities' : 'mirror changed during recovery')
    expect(f.markers.get(mirror.id)).toEqual(marker)
    expect(f.records.get(mirror.id)?.events).toEqual(initial.events)
  })
  it.each(['truncated-prefix', 'changed-prefix', 'history-bound'])('refuses %s native release evidence', async (mode) => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    f.setRelease(value => ({ ...value, snapshot: { ...initial, events: mode === 'truncated-prefix' ? []
      : mode === 'changed-prefix' ? [{ ...initial.events[0]!, digest: 'different' }]
        : [...initial.events, { ...initial.events[0]!, id: brandString<CodingSessionSnapshot['events'][number]['id']>('event-2') }] } }))
    if (mode === 'history-bound') f.options.maxEvents = 1
    await expect(f.library.releaseSequential(mirror.id)).rejects.toThrow('history could not be confirmed')
    expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain'); expect(f.records.get(mirror.id)?.events).toEqual(initial.events)
    f.setRelease(value => value); await f.library.releaseSequential(mirror.id)
  })
  it('preserves a retained conflict when release imports an appended native tail', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    f.set({ ...initial, events: [] }); await expect(f.library.continueSequential(mirror.id, 'Synthetic text', 1)).rejects.toThrow('Refresh')
    f.records.set(mirror.id, { ...f.records.get(mirror.id)!, status: 'conflict', conflict: 'history-diverged', revision: 2 })
    f.set({ ...initial, cursor: 'appended', events: [...initial.events, {
      id: brandString<CodingSessionSnapshot['events'][number]['id']>('event-2'), role: 'assistant', text: 'Synthetic append', digest: 'digest-2',
    }] })
    const released = await f.library.releaseSequential(mirror.id)
    expect(released).toMatchObject({ status: 'conflict', conflict: 'history-diverged', revision: 3,
      handoff: { phase: 'external-ready' } }); expect(released.events).toHaveLength(2)
  })
  it('refuses missing mirror readback while keeping native release uncertainty visible', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); f.records.delete(mirror.id)
    await expect(f.library.releaseSequential(mirror.id)).rejects.toThrow('not found')
    expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain')
    f.records.set(mirror.id, mirror); await f.library.releaseSequential(mirror.id)
  })
  it('refuses a release that omits a previously retained native turn identity', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); await f.library.continueSequential(mirror.id, 'Synthetic text', 1)
    f.setRelease(value => ({ ...value, nativeTurnIds: [brandString<CodingSessionNativeTurnId>('other-turn')] }))
    await expect(f.library.releaseSequential(mirror.id)).rejects.toThrow('persistence could not be confirmed')
    expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain')
    f.setRelease(value => value); await f.library.releaseSequential(mirror.id)
  })
  it('bounds the full released mirror before durable publication', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    const fresh = { ...initial, title: 'Changed title' }
    const released = { ...f.records.get(mirror.id)!, title: fresh.title, revision: 2 }
    f.options.maxBytes = Buffer.byteLength(JSON.stringify(released)) - 1; f.set(fresh)
    await expect(f.library.releaseSequential(mirror.id)).rejects.toThrow('framed byte limit')
    expect(f.records.get(mirror.id)?.title).toBe(initial.title)
    f.options.maxBytes = 100000; await f.library.releaseSequential(mirror.id)
  })
  it('preserves both native failure and non-Error journal failure in release aggregation', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await f.library.claimSequential(mirror.id, f.acknowledgement(mirror)); const store = f.options.handoffStore!
    const put = store.put.bind(store)
    store.put = async (id, marker) => {
      if (marker.phase === 'releasing' || marker.phase === 'blocked-uncertain') throw 'Synthetic storage outage'
      await put(id, marker)
    }
    await expect(f.library.releaseSequential(mirror.id)).rejects.toMatchObject({
      message: 'Native writer release or its ownership journal remains uncertain.',
      errors: [expect.objectContaining({ message: 'Native ownership journal failed.', cause: 'Synthetic storage outage' }), 'Synthetic storage outage'],
    })
    expect(f.counts.releases).toBe(1); store.put = put; await f.library.releaseSequential(mirror.id)
  })
  it('times out a synthetic reader, then joins its rejection without late publication', async () => {
    vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers() })
    const f = fixture({ timeoutMs: 10 })
    f.provider.discover = request => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        const reason: unknown = request.signal.reason
        if (!(reason instanceof Error)) throw new Error('Expected bounded abort Error')
        reject(reason)
      }, { once: true })
    })
    const pending = f.library.discover(source); const rejected = expect(pending).rejects.toThrow('time limit')
    await vi.advanceTimersByTimeAsync(10); await rejected
    expect(f.records.size).toBe(0); await f.library.cancelPending()
  })
  it('times out native release readback and retains uncertainty until a later confirmed release', async () => {
    vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers() })
    const f = fixture({ timeoutMs: 10 }); const writer = f.provider.sequentialWriter!
    let timeout = true
    onTestFinished(() => { timeout = false })
    f.provider.sequentialWriter = { ...writer, acquire: async (selected, request) => {
      const lease = await writer.acquire(selected, request)
      return { ...lease, release: limits => timeout ? new Promise((_resolve, reject) => {
        limits.signal.addEventListener('abort', () => {
          const reason: unknown = limits.signal.reason
          if (!(reason instanceof Error)) throw new Error('Expected release abort Error')
          reject(reason)
        }, { once: true })
      }) : lease.release(limits) }
    } }
    const mirror = await f.library.importSession(source); await f.library.claimSequential(mirror.id, f.acknowledgement(mirror))
    const release = f.library.releaseSequential(mirror.id); const rejected = expect(release).rejects.toThrow('readback exceeded its time limit')
    await vi.advanceTimersByTimeAsync(10); await rejected
    expect(f.markers.get(mirror.id)?.phase).toBe('blocked-uncertain')
    timeout = false; await f.library.releaseSequential(mirror.id)
  })
  it('cancels an older queued operation while joining the admitted synthetic reader', async () => {
    const f = fixture(); let entered = () => {}; let resolve = () => {}
    const admission = new Promise<void>((done) => { entered = done })
    const completion = new Promise<void>((done) => { resolve = done })
    f.provider.discover = async () => { entered(); await completion; return { items: [] } }
    const first = f.library.discover(source); const rejected = expect(first).rejects.toThrow('cancelled')
    await admission
    const queued = f.library.importSession(source); const queuedRejected = expect(queued).rejects.toThrow('cancelled')
    const cancelling = f.library.cancelPending()
    try {
      await rejected; resolve(); await queuedRejected; await cancelling
      expect(f.records.size).toBe(0)
    } finally { resolve(); await Promise.allSettled([first, queued, cancelling]) }
  })
})
