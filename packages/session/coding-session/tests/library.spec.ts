/** Native read fixtures exercise durable mirrors without native auth or a model. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CodingSessionLibrary } from '../src/library.ts'
import type { CodingSessionEvent, CodingSessionLibraryOptions, CodingSessionProvider, CodingSessionMirror, CodingSessionSource, CodingSessionSnapshot } from '../src/types.ts'

const source: CodingSessionSource = { provider: 'codex', profileId: brandString<CodingSessionSource['profileId']>('profile-a'), nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('native-original') }
const event = (id: string, text: string) => ({ id: brandString<CodingSessionEvent['id']>(id), role: 'user' as const, text, digest: `native-${text}` })
const initial: CodingSessionSnapshot = { source, title: 'Repair parser', events: [event('item-1', 'Check parser')], cursor: 'native-cursor-1', writerState: 'idle' }
function fixture(overrides: Partial<Pick<CodingSessionLibraryOptions, 'maxBytes' | 'maxMirrors'>> = {}) {
  const records = new Map<CodingSessionMirror['id'], CodingSessionMirror>()
  let snapshot = initial
  const provider: CodingSessionProvider = { provider: 'codex', profileId: source.profileId, label: 'Local Codex',
    connected: () => true, discover: async _request => ({ items: [{ source, title: 'Repair parser', writerState: 'idle' }], nextCursor: 'second-page' }),
    read: async (_id, _request) => structuredClone(snapshot),
  }
  const library = new CodingSessionLibrary({ store: {
    get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => { records.set(id, structuredClone(value)) },
  },
  pageSize: 20, maxEvents: 50, maxMirrors: 50, maxBytes: 10000, timeoutMs: 1000, ...overrides })
  const unregister = library.register(provider)
  return { library, records, provider, unregister, set: (value: CodingSessionSnapshot) => { snapshot = value } }
}

describe('coding session mirrors', () => {
  it('lists metadata without transcript bodies and reads text only through detail', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    const summary = f.library.state().mirrors[0]!
    expect(summary).toMatchObject({ id: mirror.id, source, eventCount: 1, cursor: mirror.cursor, revision: 1 })
    expect(summary).not.toHaveProperty('events'); expect(JSON.stringify(f.library.state())).not.toContain('Check parser')
    expect((await f.library.detail(mirror.id)).events[0]?.text).toBe('Check parser'); await f.library.close()
  })
  it('bounds complete inventory wrappers in UTF-8 bytes and retains readable data when full', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source); f.provider.label = '本地连接'
    const exact = Buffer.byteLength(JSON.stringify(f.library.state()), 'utf8')
    const bounded = (maxBytes: number) => {
      const library = new CodingSessionLibrary({ store: { get: id => f.records.get(id), entries: () => f.records.entries(), put: async () => { throw new Error('No inventory writes expected') } }, pageSize: 20, maxEvents: 50, maxMirrors: 50, maxBytes, timeoutMs: 1000 })
      library.register(f.provider); return library
    }
    const atLimit = bounded(exact); expect(atLimit.state().mirrors).toHaveLength(1)
    const overLimit = bounded(exact - 1); expect(() => overLimit.state()).toThrow('framed byte limit')
    expect((await overLimit.detail(mirror.id)).events[0]?.text).toBe('Check parser')
    await atLimit.close(); await overLimit.close(); await f.library.close()
  })
  it('refuses a new mirror beyond retention capacity while existing refresh stays available', async () => {
    const f = fixture({ maxMirrors: 1 }); const mirror = await f.library.importSession(source)
    const second: CodingSessionSource = { ...source, nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('another-original') }; f.set({ ...initial, source: second })
    await expect(f.library.importSession(second)).rejects.toThrow('mirror count limit')
    expect(f.records.size).toBe(1); f.set(initial); expect((await f.library.refreshMirror(mirror.id)).id).toBe(mirror.id)
    await f.library.close()
  })
  it('imports once with provider, authorized profile, and original native identity', async () => {
    const f = fixture()
    const first = await f.library.importSession(source)
    const second = await f.library.importSession(source)
    expect(second.id).toBe(first.id); expect(second.revision).toBe(1)
    expect(first.source).toEqual(source); expect(first.events.map(item => item.text)).toEqual(['Check parser'])
    expect(f.records.size).toBe(1)
    expect(first.capabilities.continue).toBe(false)
    await f.library.close()
  })
  it('keeps the same native ID isolated across authorized profiles', async () => {
    const f = fixture()
    const other: CodingSessionSource = { ...source, profileId: brandString<CodingSessionSource['profileId']>('profile-b') }
    f.library.register({ ...f.provider, profileId: other.profileId, read: async () => ({ ...initial, source: other }) })
    const a = await f.library.importSession(source); const b = await f.library.importSession(other)
    expect(a.id).not.toBe(b.id); expect(f.records.size).toBe(2)
    await f.library.close()
  })
  it('refreshes appended stable events and cursor without duplicating old history', async () => {
    const f = fixture(); const before = await f.library.importSession(source)
    f.set({ ...initial, events: [event('item-1', 'Check parser'), event('item-2', 'Parser fixed')], cursor: 'native-cursor-2' })
    const after = await f.library.refreshMirror(before.id)
    expect(after.events.map(item => item.id)).toEqual(['item-1', 'item-2']); expect(after.cursor).toBe('native-cursor-2'); expect(after.revision).toBe(2)
    expect((await f.library.refreshMirror(before.id)).revision).toBe(2)
    await f.library.close()
  })
  it.each([
    { name: 'edited', events: [event('item-1', 'Changed content')] },
    { name: 'truncated', events: [] },
    { name: 'reordered', events: [event('item-2', 'Later'), event('item-1', 'Check parser')] },
    { name: 'duplicated with changed digest', events: [event('item-1', 'Check parser'), event('item-1', 'Changed')] },
  ])('retains the mirror when $name source history diverges', async ({ events }) => {
    const f = fixture(); const before = await f.library.importSession(source); f.set({ ...initial, events, cursor: 'changed' })
    const after = await f.library.refreshMirror(before.id)
    expect(after.status).toBe('conflict'); expect(after.events).toEqual(before.events); expect(after.cursor).toBe(before.cursor)
    await expect(f.library.continueSession(before.id, 'continue', before.revision)).rejects.toThrow('writer')
    await f.library.close()
  })
  it('deduplicates exact native event redelivery while retaining order', async () => {
    const f = fixture(); f.set({ ...initial, events: [event('item-1', 'Check parser'), event('item-1', 'Check parser'), event('item-2', 'Later')] })
    const mirror = await f.library.importSession(source)
    expect(mirror.events.map(item => item.id)).toEqual(['item-1', 'item-2'])
    await f.library.close()
  })
  it('refuses continuation even for an idle source because a local lease cannot exclude a CLI writer', async () => {
    const f = fixture(); const mirror = await f.library.importSession(source)
    await expect(f.library.continueSession(mirror.id, 'continue in original session', mirror.revision)).rejects.toThrow('exclusive native writer')
    expect((await f.library.detail(mirror.id)).events).toEqual(mirror.events)
    await f.library.close()
  })
  it('refuses active source reads and cross-profile native responses', async () => {
    const f = fixture(); f.set({ ...initial, writerState: 'active' })
    await expect(f.library.importSession(source)).rejects.toThrow('active')
    f.set({ ...initial, source: { ...source, profileId: brandString<CodingSessionSource['profileId']>('wrong') } })
    await expect(f.library.importSession(source)).rejects.toThrow('identity')
    expect(f.records.size).toBe(0); await f.library.close()
  })
  it('retains existing history on disconnected and removed providers', async () => {
    const f = fixture(); const before = await f.library.importSession(source); await f.unregister()
    expect((await f.library.detail(before.id)).source).toEqual(source)
    await expect(f.library.refreshMirror(before.id)).rejects.toThrow('connected')
    expect((await f.library.detail(before.id)).events).toEqual(before.events)
    await f.library.close()
  })
  it('serializes concurrent imports and exposes native pagination without mixing profiles', async () => {
    const f = fixture(); const imported = await Promise.all([f.library.importSession(source), f.library.importSession(source)])
    expect(imported[0].id).toBe(imported[1].id); expect(f.records.size).toBe(1)
    expect(await f.library.discover({ provider: 'codex', profileId: source.profileId }, 'first-page')).toMatchObject({ nextCursor: 'second-page', items: [{ source }] })
    await f.library.close()
  })
  it('rejects a detached source response after reconnect without publishing a late mirror', async () => {
    const f = fixture(); let resolve!: (value: CodingSessionSnapshot) => void
    f.provider.read = async () => new Promise((done) => { resolve = done })
    const operation = f.library.importSession(source); await Promise.resolve(); await Promise.resolve()
    const removal = f.unregister(); f.library.register({ ...f.provider, read: async () => initial })
    resolve(initial); await expect(operation).rejects.toThrow('connection changed'); await removal
    expect(f.records.size).toBe(0); await f.library.close()
  })
  it('aborts teardown with no late persistence and refuses further reads', async () => {
    const f = fixture(); let resolve!: (value: CodingSessionSnapshot) => void
    f.provider.read = async () => new Promise((done) => { resolve = done })
    const operation = f.library.importSession(source); await Promise.resolve(); await Promise.resolve()
    const rejected = expect(operation).rejects.toThrow('closed')
    let closed = false; const closing = f.library.close().then(() => { closed = true })
    await rejected; await Promise.resolve(); expect(closed).toBe(false)
    resolve(initial); await closing; expect(f.records.size).toBe(0)
    await expect(f.library.importSession(source)).rejects.toThrow('closed')
  })
  it('bounds retained framed history and detaches values returned to callers', async () => {
    const f = fixture(); f.set({ ...initial, events: [event('item-1', 'x'.repeat(11000))] })
    await expect(f.library.importSession(source)).rejects.toThrow('limit')
    f.set(initial); const value = await f.library.importSession(source); value.events.length = 0
    expect((await f.library.detail(value.id)).events).toHaveLength(1)
    await f.library.close()
  })
})

/** A native ownership fixture enforces exclusion independently of the Y operation queue. */
describe('exclusive native writer continuation seam', () => {
  it('resumes the original native ID while holding exclusion and imports the native result', async () => {
    const f = fixture(); const resumed: string[] = []; let held = false; let settled = initial
    f.provider.writer = { authority: 'native-enforced-exclusion', acquire: async (acquiredSource) => {
      if (held) throw new Error('native writer conflict'); held = true
      return { source: acquiredSource, read: async () => settled,
        resumeOriginal: async (request) => { expect(held).toBe(true); resumed.push(request.source.nativeSessionId); settled = { ...initial, cursor: 'continued', events: [...initial.events, event('native-2', request.text)] } },
        release: async () => { held = false },
      }
    } }
    const mirror = await f.library.importSession(source)
    const result = await f.library.continueSession(mirror.id, 'Native reply', mirror.revision)
    expect(resumed).toEqual(['native-original']); expect(held).toBe(false)
    expect(result.source).toEqual(source); expect(result.events.map(value => value.text)).toEqual(['Check parser', 'Native reply'])
    expect(result.revision).toBe(2); await f.library.close()
  })
  it('refuses an external writer at atomic acquisition even after an earlier idle read', async () => {
    const f = fixture()
    f.provider.writer = { authority: 'native-enforced-exclusion', acquire: async () => { throw new Error('External native writer is active') } }
    const mirror = await f.library.importSession(source)
    await expect(f.library.continueSession(mirror.id, 'continue', mirror.revision)).rejects.toThrow('External native writer')
    expect((await f.library.detail(mirror.id)).events).toEqual(mirror.events); await f.library.close()
  })
  it.each(['wrong-source', 'divergence', 'active', 'resume-error'])('releases native exclusion on %s without replacing the source session', async (mode) => {
    const f = fixture(); let releases = 0; let resumed = 0
    f.provider.writer = { authority: 'native-enforced-exclusion', acquire: async () => ({ source: mode === 'wrong-source' ? { ...source, nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('replacement') } : source,
      read: async () => mode === 'divergence' ? { ...initial, events: [event('item-1', 'Changed')] } : mode === 'active' ? { ...initial, writerState: 'active' } : initial,
      resumeOriginal: async () => { resumed++; throw new Error('native resume failed') }, release: async () => { releases++ },
    }) }
    const mirror = await f.library.importSession(source)
    await expect(f.library.continueSession(mirror.id, 'continue', mirror.revision)).rejects.toThrow()
    expect(releases).toBe(1); expect(resumed).toBe(mode === 'resume-error' ? 1 : 0)
    expect((await f.library.detail(mirror.id)).source).toEqual(source); await f.library.close()
  })
})

describe('coding-session operation quiescence', () => {
  it('cancels an original-ID turn and awaits native settlement and release before draining', async () => {
    const f = fixture(); let entered!: () => void; let finishTurn!: () => void; let finishRelease!: () => void
    const enteredTurn = new Promise<void>((done) => { entered = done }); let held = false; let aborted = false; let releaseEntered = false
    f.provider.writer = { authority: 'native-enforced-exclusion', acquire: async (acquiredSource) => {
      held = true
      return { source: acquiredSource, read: async () => initial, resumeOriginal: async (request) => {
        expect(request.source).toEqual(source); request.signal.addEventListener('abort', () => { aborted = true }, { once: true })
        entered(); await new Promise<void>((done) => { finishTurn = done }); expect(held).toBe(true)
      }, release: async () => { releaseEntered = true; await new Promise<void>((done) => { finishRelease = done }); held = false } }
    } }
    const mirror = await f.library.importSession(source)
    const continued = f.library.continueSession(mirror.id, 'continue original', mirror.revision); const rejected = expect(continued).rejects.toThrow('cancelled')
    await enteredTurn; let drained = false; const cancelling = f.library.cancelPending().then(() => { drained = true })
    expect(aborted).toBe(true); expect(held).toBe(true); expect(drained).toBe(false)
    finishTurn(); await Promise.resolve(); await Promise.resolve(); expect(releaseEntered).toBe(true); expect(drained).toBe(false)
    finishRelease(); await rejected; await cancelling; expect(held).toBe(false)
    expect((await f.library.detail(mirror.id)).revision).toBe(1); await f.library.close()
  })
  it('refuses a queued stale reviewed revision before acquiring a native writer', async () => {
    const f = fixture(); let acquired = false
    f.provider.writer = { authority: 'native-enforced-exclusion', acquire: async () => { acquired = true; throw new Error('should not acquire') } }
    const mirror = await f.library.importSession(source)
    f.set({ ...initial, events: [...initial.events, event('item-2', 'external turn')], cursor: 'external-append' })
    await f.library.refreshMirror(mirror.id)
    await expect(f.library.continueSession(mirror.id, 'continue', mirror.revision)).rejects.toThrow('changed')
    expect(acquired).toBe(false); await f.library.close()
  })
  it('drains native lease release when the source reconnects during acquisition', async () => {
    const f = fixture(); let acquired!: () => void; let releaseAcquisition!: () => void; let released = false; let resumed = false
    const enteredAcquire = new Promise<void>((done) => { acquired = done })
    f.provider.writer = { authority: 'native-enforced-exclusion', acquire: async () => {
      acquired(); await new Promise<void>((done) => { releaseAcquisition = done })
      return { source, read: async () => initial, resumeOriginal: async () => { resumed = true }, release: async () => { released = true } }
    } }
    const mirror = await f.library.importSession(source); const continued = f.library.continueSession(mirror.id, 'continue', mirror.revision)
    const rejected = expect(continued).rejects.toThrow('connection changed'); await enteredAcquire
    const removal = f.unregister(); f.library.register({ ...f.provider }); releaseAcquisition(); await rejected; await removal
    expect(released).toBe(true); expect(resumed).toBe(false); await f.library.close()
  })
  it('waits for an in-flight durable put before disposal returns', async () => {
    const records = new Map<CodingSessionMirror['id'], CodingSessionMirror>(); let commit!: () => void; let entered!: () => void
    const enteredPut = new Promise<void>((done) => { entered = done })
    const library = new CodingSessionLibrary({ store: {
      get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => {
        entered(); await new Promise<void>((done) => { commit = done }); records.set(id, value)
      } }, pageSize: 10, maxEvents: 20, maxMirrors: 50, maxBytes: 10000, timeoutMs: 1000 })
    library.register({ provider: 'codex', profileId: source.profileId, label: 'Codex', connected: () => true, discover: async () => ({ items: [] }), read: async () => initial })
    const imported = library.importSession(source); const rejected = expect(imported).rejects.toThrow('closed'); await enteredPut
    let closed = false; const closing = library.close().then(() => { closed = true })
    await rejected; await Promise.resolve(); expect(closed).toBe(false)
    commit(); await closing; expect(records.size).toBe(1)
    const afterDispose = records.size; await Promise.resolve(); expect(records.size).toBe(afterDispose)
  })
  it('cancels a pending read and drains it without publishing its late result', async () => {
    const f = fixture(); let resolve!: (value: CodingSessionSnapshot) => void
    f.provider.read = () => new Promise((done) => { resolve = done })
    const imported = f.library.importSession(source); const rejected = expect(imported).rejects.toThrow('cancelled'); await Promise.resolve(); await Promise.resolve()
    let drained = false; const cancelling = f.library.cancelPending().then(() => { drained = true })
    await rejected; expect(drained).toBe(false); resolve(initial); await cancelling
    expect(f.records.size).toBe(0); await f.library.close()
  })
  it('rejects empty and overbudget continuation before native acquisition', async () => {
    const f = fixture(); let acquired = false
    f.provider.writer = { authority: 'native-enforced-exclusion', acquire: async () => { acquired = true; throw new Error('should not acquire') } }
    const mirror = await f.library.importSession(source)
    await expect(f.library.continueSession(mirror.id, '   ', mirror.revision)).rejects.toThrow('message')
    await expect(f.library.continueSession(mirror.id, 'x'.repeat(11000), mirror.revision)).rejects.toThrow('limit')
    expect(acquired).toBe(false); await f.library.close()
  })
})
