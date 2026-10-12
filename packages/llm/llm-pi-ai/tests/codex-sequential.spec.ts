/** Mock original-profile continuation; never launches a native child or a model. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionReadRequest, CodingSessionSource, CodingSessionOwnerToken, CodingSessionSequentialWriterLease } from '@deepseek-ai/dsh-coding-session/types'
import { createConfiguredCodexSessionProvider } from '../src/coding-session-source.ts'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import type { CodexSequentialPeer } from '../src/codex-sequential-process.ts'
import { CodingSessionLibrary } from '@deepseek-ai/dsh-coding-session/src/library.ts'
import type { CodingSessionMirror, CodingSessionHandoff, CodingSessionClaimAcknowledgement } from '@deepseek-ai/dsh-coding-session/types'
import { createCodexCodingSessionProvider } from '../src/codex-coding-sessions.ts'
import { createCodexSequentialOwner } from '../src/codex-sequential.ts'
import type { CodexSequentialAccess } from '../src/codex-sequential.ts'
import { restrictedConfig } from '../src/codex-sequential-guards.ts'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'

type Obj = Record<string, unknown>
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const read = (): CodingSessionReadRequest => ({ signal: new AbortController().signal, limit: 10, maxEvents: 100, maxBytes: 1024 * 1024 })
async function fixture(priorEmpty = false, options: {
  resumeTouch?: boolean
  richHistory?: boolean
  observedReads?: boolean
  observedPatches?: boolean
  staleRead?: boolean
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'y-codex-sequential-fixture-')); roots.push(directory)
  const home = join(directory, 'native'); const cwd = join(directory, 'project'); await Promise.all([mkdir(home), mkdir(cwd)])
  const profileId = brandString<CodingSessionSource['profileId']>('fixture-profile')
  const source: CodingSessionSource = { provider: 'codex', profileId, nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('fixture-original') }
  const config: CodexSessionSourceConfig = { id: 'fixture', label: 'Fixture', home, cwd, shellHome: join(directory, 'shell'), nodePath: '/fixture/node',
    knownNoManagedFeatureOverrides: true, binary: '/fixture/codex.js', packageManifest: '/fixture/package.json', binarySha256: '0'.repeat(64), version: '0.160.0', graceMs: 1000 }
  const access: CodexSequentialAccess = { authority: {}, cwd, sandbox: 'workspace-write', writableRoots: [cwd], approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    request: vi.fn(async () => ({ answers: {} })) }
  const getAccess = vi.fn(() => access)
  let opened = 0; let dispatched = 0; let changedConfig = false; let omitReadback = false; let wrongResume = false; let closeFailure = false
  let reusedTurn = false; let omittedUserInput = false
  let timestamp = 100; let title = 'Fixture'; let extraItem = false; let extraEmpty = false; let reversed = false
  let acquisitionMutation: string | undefined; let observedFailure = false
  const mutate = (change: string): void => {
    if (change === 'timestamp') timestamp++
    else if (change === 'title') title = 'Externally renamed'
    else if (change === 'item') extraItem = true
    else if (change === 'empty-turn') extraEmpty = true
    else if (change === 'prior-status') priorStatus = 'failed'
    else if (change === 'reorder') reversed = true
    else throw new Error(`Unknown fixture mutation ${change}`)
  }
  let terminalStatus = 'completed'; let ownStatus = 'completed'; let coldStatus: string | undefined; let priorStatus = 'completed'
  let coldFailureOnce = false; let managedFeatures: Record<string, boolean> | null = null
  let mismatchFull = false; let mismatchHead = false; let readerCleanupFailure = false
  const closures: number[] = []
  let disposalFailure = false; let closeBarrier: Promise<void> | undefined
  const calls: Array<{ process: number; method: string; params: object | undefined }> = []
  const disposals: number[] = []
  const routes = new Map<number, (method: string, params: Obj) => Promise<unknown> | undefined>()
  const nativeThread = (number: number, resumed: boolean) => ({
    id: source.nativeSessionId, name: title, preview: title, cwd, updatedAt: timestamp,
    historyMode: 'legacy', status: { type: resumed ? 'idle' : 'notLoaded' },
    turns: [...(reversed ? [1, 0] : [0, ...(options.richHistory === true ? [1] : [])]).map(index => index === 1
      ? { id: 'prior-empty', status: 'completed', itemsView: 'full', items: [] }
      : { id: 'prior-turn', status: priorStatus, itemsView: 'full', items: priorEmpty ? [] : [{ id: 'prior-item', type: 'agentMessage', text: 'Prior saved content' }, ...(extraItem ? [{ id: 'external-item', type: 'agentMessage', text: 'External saved content' }] : [])] }),
    ...(extraEmpty ? [{ id: 'external-empty', status: 'completed', itemsView: 'full', items: [] }] : []),
    ...(dispatched === 0 || (omitReadback && number >= 3) ? [] : [{ id: 'own-turn', status: number >= 3 ? coldStatus ?? ownStatus : ownStatus, itemsView: 'full',
      items: [...(omittedUserInput ? [] : [{ id: 'own-user', type: 'userMessage', content: [{ type: 'text', text: 'Continue fixture' }] }]), { id: 'own-answer', type: 'agentMessage', text: 'Saved native answer' }] }])] })
  const factory = vi.fn(async (
    _config: CodexSessionSourceConfig, _request: CodingSessionReadRequest, servers: Record<string, { enabled: false }>,
  ) => {
    const number = ++opened; let resumed = false; let closed = false
    const callbacks = new Set<(method: string, params: Obj) => void>()
    let requestHandler: ((method: string, params: Obj) => Promise<unknown>) | undefined
    const peer: CodexSequentialPeer = { connected: () => !closed, observedFailure: () => observedFailure,
      onRequest: (callback) => { requestHandler = callback },
      subscribe: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback) } },
      request: async (method, params, signal) => {
        signal.throwIfAborted(); calls.push({ process: number, method, params })
        if (method === 'configRequirements/read') return { requirements: { featureRequirements: managedFeatures } }
        if (method === 'config/read') {
          const value = restrictedConfig({ mcp_servers: { 'literal.name': { command: 'fixture-only', enabled: true } } }, servers)
          return { config: changedConfig && number === 2 ? { ...value, notify: ['changed'] } : value }
        }
        if (method === 'thread/read') {
          if (number >= 3 && coldFailureOnce) { coldFailureOnce = false; throw new Error('Fixture transient cold reader failure') }
          const parsed: unknown = params === undefined ? undefined : Reflect.get(params, 'includeTurns')
          const value = nativeThread(number, resumed)
          return { thread: mismatchHead ? { ...value, cwd: '/fixture/wrong-cwd', status: { type: 'active' } }
            : mismatchFull && parsed === true ? { ...value, status: { type: 'idle' } } : value }
        }
        if (method === 'thread/resume') { resumed = true; if (options.resumeTouch === true) timestamp++; if (acquisitionMutation !== undefined) mutate(acquisitionMutation); return { thread: { ...nativeThread(number, resumed), id: wrongResume ? 'replacement' : source.nativeSessionId }, cwd,
          approvalPolicy: access.approvalPolicy, approvalsReviewer: 'user', sandbox: access.sandboxPolicy } }
        if (method === 'mcpServerStatus/list') return { data: [{ name: 'literal.name', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] }] }
        if (method === 'turn/start') {
          dispatched++; timestamp++
          queueMicrotask(() => {
            if (options.observedReads === true) for (const [index, path] of ['src/a.ts', 'src/b.ts'].entries()) {
              const item = { id: `read-${index}`, type: 'commandExecution', source: 'agent', command: `cat ${path}`, cwd,
                commandActions: [{ type: 'read', command: `cat ${path}`, path: join(cwd, path) }], status: 'completed', exitCode: 0,
                aggregatedOutput: 'Authorization: Bearer native-secret-must-not-survive' }
              for (const callback of callbacks) {
                callback('item/started', { threadId: source.nativeSessionId, turnId: options.staleRead === true ? 'prior-turn' : 'own-turn', item })
                callback('item/completed', { threadId: source.nativeSessionId, turnId: options.staleRead === true ? 'prior-turn' : 'own-turn', item })
              }
            }
            if (options.observedPatches === true) for (const [index, path] of ['src/a.ts', 'src/b.ts'].entries()) {
              const item = { id: `patch-${index}`, type: 'fileChange', changes: [{ path: join(cwd, path),
                kind: { type: index === 0 ? 'update' : 'add' }, diff: 'Authorization: Bearer native-private-diff' }] }
              for (const callback of callbacks) {
                callback('item/started', { threadId: source.nativeSessionId, turnId: 'own-turn', item: { ...item, status: 'inProgress' } })
                callback('item/completed', { threadId: source.nativeSessionId, turnId: 'own-turn', item: { ...item, status: 'completed' } })
              }
            }
            for (const callback of callbacks) callback('turn/completed', { threadId: source.nativeSessionId, turn: { id: 'own-turn', status: terminalStatus } })
          })
          return { turn: { id: reusedTurn ? 'prior-turn' : 'own-turn', status: 'inProgress' } }
        }
        if (method === 'turn/interrupt') return {}
        throw new Error(`Unexpected fixture method ${method}`)
      }, close: async () => { closures.push(number); closed = true; for (const callback of callbacks) callback('__closed', {}); if (number === 2) await closeBarrier; if ((closeFailure && number === 2) || (readerCleanupFailure && number >= 3)) throw new Error('Fixture stream/range release uncertain') },
      dispose: async () => { disposals.push(number); closed = true; if ((disposalFailure && number === 2) || (readerCleanupFailure && number >= 3)) throw new Error('Fixture unknown owned range') },
    }
    Object.assign(peer, { fixtureRequest: (method: string, params: Obj) => requestHandler?.(method, params) })
    routes.set(number, (method, params) => requestHandler?.(method, params))
    return peer
  })
  const owner = createCodexSequentialOwner(config, 'fixture-profile', profileId, getAccess, factory, async () => {})
  const provider = createCodexCodingSessionProvider('fixture-profile', 'Fixture', () => ({ connected: () => true, request: async () => ({ thread: nativeThread(0, false) }) }))
  provider.sequentialWriter = owner.writer
  const acquire = () => owner.writer.acquire(source, { ...read(), ownerToken: brandString<CodingSessionOwnerToken>('fixture-owned-instance'), nativeProfileUnchanged: true })
  return { owner, provider, source, config, mutate, access, getAccess, calls, factory, disposals, closures, acquire,
    observedPersistenceFailure: () => { observedFailure = true }, duringResume: (change: string) => { acquisitionMutation = change },
    failedNotice: (status: string) => { terminalStatus = status }, savedOwnStatus: (status: string) => { ownStatus = status },
    coldSavedStatus: (status: string) => { coldStatus = status }, changedPriorStatus: (status = 'failed') => { priorStatus = status },
    transientColdFailure: () => { coldFailureOnce = true }, unknownReaderCleanup: () => { readerCleanupFailure = true },
    forcedFeatures: (features: Record<string, boolean> | null) => { managedFeatures = features },
    wrongFullHistory: () => { mismatchFull = true }, wrongHeadHistory: () => { mismatchHead = true },
    serverRequest: (method: string, params: Obj) => routes.get(2)?.(method, params),
    reusedTurn: () => { reusedTurn = true }, omittedUserInput: () => { omittedUserInput = true },
    disposalFailure: () => { disposalFailure = true },
    holdClose: () => { let resolve!: () => void; closeBarrier = new Promise<void>((finish) => { resolve = finish }); return resolve },
    changedConfig: () => { changedConfig = true }, omitReadback: () => { omitReadback = true },
    wrongResume: () => { wrongResume = true }, closeFailure: () => { closeFailure = true } }
}
function composed(f: Awaited<ReturnType<typeof fixture>>) {
  const records = new Map<CodingSessionMirror['id'], CodingSessionMirror>()
  const markers = new Map<CodingSessionMirror['id'], CodingSessionHandoff>()
  const library = new CodingSessionLibrary({
    store: { get: id => records.get(id), entries: () => records.entries(),
      put: async (id, value) => { records.set(id, structuredClone(value)) } },
    pageSize: 10, maxEvents: 100, maxMirrors: 10, maxBytes: 1024 * 1024, timeoutMs: 1000, enableSequentialHandoff: true,
    handoffStore: { get: id => markers.get(id), entries: () => markers.entries(),
      put: async (id, value) => { markers.set(id, structuredClone(value)) } },
  })
  library.register(f.provider)
  const acknowledgement = (mirror: CodingSessionMirror): CodingSessionClaimAcknowledgement => ({
    source: mirror.source, project: f.access.cwd,
    expectedRevision: mirror.revision, externalWritersClosed: true, nativeProfileUnchanged: true,
    executionSessionId: brandString<CodingSessionClaimAcknowledgement['executionSessionId']>('selected-live-y-root') })
  return { library, markers, acknowledgement }
}
describe('Codex acknowledged original-ID project-files owner', () => {
  it('claims the reviewed original ID after native resume touches metadata, then publishes the real completed-turn and cold-release cursors', async () => {
    const f = await fixture(false, { resumeTouch: true, richHistory: true }); const h = composed(f)
    try {
      const mirror = await h.library.importSession(f.source)
      const claimed = await h.library.claimSequential(mirror.id, h.acknowledgement(mirror))
      expect(claimed.handoff?.phase).toBe('y-owned'); expect(claimed.cursor).toBe(mirror.cursor)
      const actualAfterResume = await f.provider.read(f.source.nativeSessionId, read())
      expect(actualAfterResume.cursor).not.toBe(mirror.cursor)
      const continued = await h.library.continueSequential(mirror.id, 'Continue fixture', claimed.revision)
      expect(continued.source).toEqual(f.source)
      expect(continued.events.map(event => event.text)).toEqual(['Prior saved content', 'Continue fixture', 'Saved native answer'])
      expect(continued.cursor).toBe((await f.provider.read(f.source.nativeSessionId, read())).cursor)
      const released = await h.library.releaseSequential(mirror.id)
      expect(released.handoff?.phase).toBe('external-ready')
      expect(released.cursor).toBe((await f.provider.read(f.source.nativeSessionId, read())).cursor)
      expect(released.handoff?.nativeTurnIds).toEqual(['own-turn'])
    } finally { await h.library.close(); await f.owner.close() }
  })
  it.each(['title', 'item', 'empty-turn', 'prior-status', 'reorder'])('refuses %s changed by cold resume before exposing a held claim', async (change) => {
    const f = await fixture(change === 'prior-status', { resumeTouch: true, richHistory: true }); f.duringResume(change)
    try { await expect(f.acquire()).rejects.toThrow(/changed|preserved/); expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([]) }
    finally { await f.owner.close() }
  })
  it.each(['timestamp', 'title', 'item', 'empty-turn', 'prior-status', 'reorder'])('refuses a later %s change on held read and before durable native admission', async (change) => {
    const f = await fixture(change === 'prior-status', { resumeTouch: true, richHistory: true }); const lease = await f.acquire(); f.mutate(change)
    const admission = vi.fn(async () => {})
    try {
      await expect(lease.read(read())).rejects.toThrow(/changed|preserved/)
      await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: admission })).rejects.toThrow(/changed/)
      expect(admission).not.toHaveBeenCalled(); expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([])
    } finally { await f.owner.close() }
  })
  it('keeps stale reviewed preflight metadata subject to the Host refresh check', async () => {
    const f = await fixture(false, { resumeTouch: true }); const h = composed(f)
    try {
      const mirror = await h.library.importSession(f.source); f.mutate('timestamp')
      await expect(h.library.claimSequential(mirror.id, h.acknowledgement(mirror))).rejects.toThrow(/Refresh/)
      expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([])
    } finally { await h.library.close(); await f.owner.close() }
  })
  it('publishes the actual cold cursor when a metadata-touched claim is released without a model turn', async () => {
    const f = await fixture(false, { resumeTouch: true }); const h = composed(f)
    try {
      const mirror = await h.library.importSession(f.source)
      await h.library.claimSequential(mirror.id, h.acknowledgement(mirror))
      const released = await h.library.releaseSequential(mirror.id)
      expect(released.handoff?.phase).toBe('external-ready'); expect(released.handoff?.nativeTurnIds).toEqual([])
      expect(released.cursor).not.toBe(mirror.cursor)
      expect(released.cursor).toBe((await f.provider.read(f.source.nativeSessionId, read())).cursor)
      expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([])
    } finally { await h.library.close(); await f.owner.close() }
  })
  it('refuses an already observed persistence failure before retained read and durable native admission', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.observedPersistenceFailure()
    const admission = vi.fn(async () => {})
    try {
      await expect(lease.read(read())).rejects.toThrow(/failure/)
      await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: admission })).rejects.toThrow(/failure/)
      expect(admission).not.toHaveBeenCalled(); expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([])
    } finally { await f.owner.close() }
  })
  it('cold claims without a model turn and verifies original saved history after natural release', async () => {
    const f = await fixture(); const lease = await f.acquire()
    expect(f.owner.writer.toolMode).toBe('project-files')
    expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([])
    expect(f.calls.filter(call => call.method === 'configRequirements/read').every(call => call.params === undefined)).toBe(true)
    expect(f.calls.find(call => call.method === 'thread/resume')?.params).toMatchObject({ threadId: f.source.nativeSessionId })
    const receipt = await lease.release(read())
    expect(receipt).toMatchObject({ source: f.source, processExited: true, streamsDrained: true, expectedPrefixPersisted: true,
      completedTurnPersisted: false, nativeTurnIds: [], noObservedPersistenceErrors: true })
    expect(f.factory).toHaveBeenCalledTimes(3)
    expect(f.calls.filter(call => call.process === 3 && call.method === 'thread/resume')).toEqual([])
    await f.owner.close()
  })
  it('awaits exactly one durable admission before same-ID dispatch and verifies the saved native turn', async () => {
    const f = await fixture(); const lease = await f.acquire()
    const admission = vi.fn(async () => { expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([]) })
    const result = await lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: admission })
    expect(admission).toHaveBeenCalledTimes(1); expect(result.nativeTurnId).toBe('own-turn')
    const start = f.calls.find(call => call.method === 'turn/start')
    expect(start?.params).toMatchObject({ threadId: f.source.nativeSessionId, serviceTierForTurn: 'default', sandboxPolicy: f.access.sandboxPolicy })
    expect(start?.params).not.toHaveProperty('history'); expect(start?.params).not.toHaveProperty('model')
    expect(await lease.release(read())).toMatchObject({ completedTurnPersisted: true, nativeTurnIds: ['own-turn'] })
    await f.owner.close()
  })
  it('refuses changed source configuration before durable admission and native model dispatch', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.changedConfig(); const admission = vi.fn(async () => {})
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: admission })).rejects.toThrow(/configuration changed/)
    expect(admission).not.toHaveBeenCalled(); expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([])
    await expect(f.acquire()).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it('rechecks live authority after the awaited durable admission before sending a model request', async () => {
    const f = await fixture(); const lease = await f.acquire()
    const admission = vi.fn(async () => { f.getAccess.mockImplementation(() => { throw new Error('Fixture root removed') }) })
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: admission })).rejects.toThrow(/root removed/)
    expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([]); await f.owner.close()
  })
  it('rejects a replacement ID before exposing a held owner', async () => {
    const f = await fixture(); f.wrongResume(); await expect(f.acquire()).rejects.toThrow(/identity/)
    expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([]); expect(f.disposals).toContain(2); await f.owner.close()
  })
  it('retains unresolved ownership when the cold public readback loses an expected saved turn', async () => {
    const f = await fixture(); const lease = await f.acquire()
    await lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {} })
    f.omitReadback(); await expect(lease.release(read())).rejects.toThrow(/omitted a completed native turn/)
    await expect(f.acquire()).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it('does not start a fresh readback until normal writer process/streams are confirmed', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.closeFailure()
    await expect(lease.release(read())).rejects.toThrow(/uncertain/)
    expect(f.factory).toHaveBeenCalledTimes(2); await expect(f.acquire()).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it('rejects broad writable access before any native process opens', async () => {
    const f = await fixture(); f.access.sandbox = 'danger-full-access'
    await expect(f.acquire()).rejects.toThrow(/confined/); expect(f.factory).not.toHaveBeenCalled(); await f.owner.close()
  })
  it('rejects a different live root object even with the same project and policy', async () => {
    const f = await fixture(); const lease = await f.acquire()
    f.getAccess.mockImplementation(() => ({ ...f.access, authority: {} }))
    await expect(lease.read(read())).rejects.toThrow(/authority/)
    // Resource release does not need that original root to survive.
    expect(await lease.release(read())).toMatchObject({ completedTurnPersisted: false }); await f.owner.close()
  })
  it('does not ask a Y question for a stale native turn before actual dispatch', async () => {
    const f = await fixture(); const lease = await f.acquire()
    await lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {
      expect(await f.serverRequest('item/tool/requestUserInput', { threadId: f.source.nativeSessionId, turnId: 'prior-turn', questions: [] })).toEqual({ answers: {} })
    } })
    expect(f.access.request).not.toHaveBeenCalled(); await lease.release(read()); await f.owner.close()
  })
  it('refuses a reused native turn ID after durable admission', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.reusedTurn()
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {} })).rejects.toThrow(/reused/)
    await expect(lease.release(read())).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it('does not claim turn persistence from a native ID lacking the exact saved admitted user input', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.omittedUserInput()
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {} })).rejects.toThrow(/admitted user input/)
    await expect(lease.release(read())).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it('blocks a second release until the single original owner finishes its readback', async () => {
    const f = await fixture(); const lease = await f.acquire(); const finish = f.holdClose()
    const release = lease.release(read())
    await expect(lease.release(read())).rejects.toThrow(/already in progress/)
    finish(); await release; expect(f.factory).toHaveBeenCalledTimes(3); await f.owner.close()
  })
  it('poisons the profile when acquisition cleanup cannot establish owned-range quiescence', async () => {
    const f = await fixture(); f.wrongResume(); f.disposalFailure()
    await expect(f.acquire()).rejects.toThrow(/unresolved owned process range/)
    await expect(f.acquire()).rejects.toThrow(/unresolved owned process range/)
    expect(f.factory).toHaveBeenCalledTimes(2); await expect(f.owner.close()).rejects.toThrow(/unresolved/)
  })
  it('rejects an existing writable root covering the native profile before opening a peer', async () => {
    const f = await fixture(); f.access.writableRoots = [join(f.access.cwd, '..')]
    await expect(f.acquire()).rejects.toThrow(/native profile/)
    expect(f.factory).not.toHaveBeenCalled(); await f.owner.close()
  })
  it('rejects cwd outside the existing Y writable roots before native WorkspaceWrite can implicitly grant it', async () => {
    const f = await fixture(); f.access.writableRoots = []
    await expect(f.acquire()).rejects.toThrow(/widen Harness writes/)
    expect(f.factory).not.toHaveBeenCalled(); await f.owner.close()
  })
  it.each(['failed', 'interrupted'])('refuses a %s terminal notice despite saved matching user input', async (status) => {
    const f = await fixture(); const lease = await f.acquire(); f.failedNotice(status)
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {} })).rejects.toThrow(/terminal receipt/)
    await expect(lease.release(read())).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it.each(['failed', 'interrupted'])('refuses a persisted %s own turn after a completed notice', async (status) => {
    const f = await fixture(); const lease = await f.acquire(); f.savedOwnStatus(status)
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {} })).rejects.toThrow(/completed native turn/)
    await expect(lease.release(read())).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it.each(['failed', 'interrupted'])('refuses a cold readback %s status after completed settlement', async (status) => {
    const f = await fixture(); const lease = await f.acquire()
    await lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {} })
    f.coldSavedStatus(status); await expect(lease.release(read())).rejects.toThrow(/saved turn statuses/)
    await expect(f.acquire()).rejects.toThrow(/unresolved/); await f.owner.close()
  })
  it.each(['failed', 'interrupted'])('preserves an empty prior turn status when it changes to %s without any item-prefix change', async (status) => {
    const f = await fixture(true); const lease = await f.acquire(); f.changedPriorStatus(status)
    const admission = vi.fn(async () => {})
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: admission })).rejects.toThrow(/statuses changed/)
    expect(admission).not.toHaveBeenCalled(); await f.owner.close()
  })
  it('retries fresh cold readback after independently healthy expected writer closure', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.transientColdFailure()
    await expect(lease.release(read())).rejects.toThrow(/transient cold reader/)
    expect(f.closures.filter(number => number === 2)).toHaveLength(1); expect(f.disposals).not.toContain(2)
    await expect(f.acquire()).rejects.toThrow(/unresolved/)
    expect(await lease.release(read())).toMatchObject({ processExited: true, streamsDrained: true, completedTurnPersisted: false })
    expect(f.factory).toHaveBeenCalledTimes(4); expect(f.closures.filter(number => number === 2)).toHaveLength(1); await f.owner.close()
  })
  it('returns isolated cached release evidence for a journal retry without starting a new reader', async () => {
    const f = await fixture(); const lease = await f.acquire(); const receipt = await lease.release(read())
    // Simulate caller journal failure and accidental mutation of its returned value.
    receipt.snapshot.events.length = 0
    const retry = await lease.release(read())
    expect(retry.snapshot.events).toHaveLength(1); expect(retry.nativeTurnIds).toEqual([])
    expect(f.factory).toHaveBeenCalledTimes(3); await f.owner.close()
  })
  it('refuses managed forced-on capabilities before original resume', async () => {
    const f = await fixture(); f.forcedFeatures({ shell_tool: true })
    await expect(f.acquire()).rejects.toThrow(/forced-on/)
    expect(f.calls.filter(call => call.method === 'thread/resume')).toEqual([]); await f.owner.close()
  })
  it('refuses a new managed forced-on capability before durable turn admission', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.forcedFeatures({ code_mode_host: true })
    const admission = vi.fn(async () => {})
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: admission })).rejects.toThrow(/forced-on/)
    expect(admission).not.toHaveBeenCalled(); expect(f.calls.filter(call => call.method === 'turn/start')).toEqual([]); await f.owner.close()
  })
  it('accepts unchanged managed false requirements with exact public unit request fields', async () => {
    const f = await fixture(); f.forcedFeatures({ shell_tool: false, code_mode_host: false }); const lease = await f.acquire()
    expect(await lease.release(read())).toMatchObject({ expectedPrefixPersisted: true })
    expect(f.calls.filter(call => call.method === 'configRequirements/read').every(call => call.params === undefined)).toBe(true); await f.owner.close()
  })
  it('refuses legacy full turn history whose idle status differs from its cold header', async () => {
    const f = await fixture(); f.wrongFullHistory()
    await expect(f.acquire()).rejects.toThrow(/changed its source/); await f.owner.close()
  })
  it('refuses an original turn header whose cwd or runtime status is incompatible', async () => {
    const f = await fixture(); f.wrongHeadHistory()
    await expect(f.acquire()).rejects.toThrow(); await f.owner.close()
  })

  it('blocks every release retry when a readback reader range failed to confirm disposal', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.unknownReaderCleanup()
    await expect(lease.release(read())).rejects.toThrow(/uncertain/)
    await expect(lease.release(read())).rejects.toThrow(/unresolved owned process range/)
    expect(f.factory).toHaveBeenCalledTimes(3); await expect(f.acquire()).rejects.toThrow(/unresolved/)
    await expect(f.owner.close()).rejects.toThrow(/unresolved/)
  })

  it.each([undefined, false])('keeps an unknown/false trusted managed declaration reader-only (%s)', async (declaration) => {
    const f = await fixture(); const spawn = vi.fn(() => { throw new Error('Fixture must never launch') })
    const selected = { ...f.config, enableSequentialProjectFiles: true }
    if (declaration === undefined) delete selected.knownNoManagedFeatureOverrides
    else selected.knownNoManagedFeatureOverrides = declaration
    const provider = createConfiguredCodexSessionProvider(selected, spawn)
    expect(provider.sequentialWriter).toBeUndefined(); expect(spawn).not.toHaveBeenCalled()
    await provider.close(); await f.owner.close()
  })
  it('registers the default-off sequential capability only with both explicit source declarations', async () => {
    const f = await fixture(); const spawn = vi.fn(() => { throw new Error('Fixture must never launch') })
    const provider = createConfiguredCodexSessionProvider({ ...f.config, enableSequentialProjectFiles: true }, spawn, f.getAccess)
    expect(provider.sequentialWriter?.toolMode).toBe('project-files'); expect(spawn).not.toHaveBeenCalled()
    await provider.close(); await f.owner.close()
  })

})


type ObservedTurnRequest = Parameters<CodingSessionSequentialWriterLease['resumeOriginal']>[0] & {
  onNativeTurn?(id: string): Promise<void>
  onNativeItem?(item: SkillLearningNativeItem): Promise<void>
}
it('delivers only sanitized correlated current-turn native read facts and awaits their durability callback', async () => {
  const f = await fixture(false, { observedReads: true }); const lease = await f.acquire()
  const items: SkillLearningNativeItem[] = []; const order: string[] = []
  let release = () => {}; const storage = new Promise<void>((resolve) => { release = resolve })
  const request: ObservedTurnRequest = { source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {},
    onNativeTurn: async (id) => { order.push(id) }, onNativeItem: async (item) => { await storage; items.push(item) } }
  let completed = false; const pending = lease.resumeOriginal(request).then((result) => { completed = true; return result })
  await vi.waitFor(() => { expect(order).toEqual(['own-turn']) })
  expect(completed).toBe(false); release(); await pending
  expect(items).toHaveLength(4)
  expect(items.map(item => item.phase)).toEqual(['started', 'settled', 'started', 'settled'])
  expect(items.map(item => item.procedure)).toEqual([{ kind: 'read', path: 'src/a.ts' }, { kind: 'read', path: 'src/a.ts' }, { kind: 'read', path: 'src/b.ts' }, { kind: 'read', path: 'src/b.ts' }])
  expect(JSON.stringify(items)).not.toMatch(/native-secret|aggregatedOutput|commandActions/)
  expect(items.every(item => item.provider === 'codex' && item.connectionId === 'fixture-profile' && item.sessionId === 'fixture-original' && item.turnId === 'own-turn')).toBe(true)
  await lease.release(read()); await f.owner.close()
})
it('refuses native observation callback failure rather than returning a clean completed turn', async () => {
  const f = await fixture(false, { observedReads: true }); const lease = await f.acquire()
  const request: ObservedTurnRequest = { source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {},
    onNativeTurn: async () => {}, onNativeItem: async () => { throw new Error('Fixture native observation durability failed') } }
  await expect(lease.resumeOriginal(request)).rejects.toThrow(/native|durab|observ/i)
  await f.owner.close()
})
it('delivers paired current-turn public file-change facts without retaining native diff bodies', async () => {
  const f = await fixture(false, { observedPatches: true }); const lease = await f.acquire()
  const items: SkillLearningNativeItem[] = []; let currentTurn: string | undefined
  let release = () => {}; const storage = new Promise<void>((resolve) => { release = resolve })
  const request: ObservedTurnRequest = { source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {},
    onNativeTurn: async (id) => { currentTurn = id }, onNativeItem: async (item) => { expect(currentTurn).toBe(item.provider === 'codex' ? item.turnId : undefined); await storage; items.push(item) } }
  let completed = false; const pending = lease.resumeOriginal(request).then((result) => { completed = true; return result })
  await vi.waitFor(() => { expect(currentTurn).toBe('own-turn') }); expect(completed).toBe(false)
  release(); await pending
  expect(items.map(item => [item.kind, item.phase, item.outcome])).toEqual([
    ['file-change', 'started', undefined], ['file-change', 'settled', 'reported-success'],
    ['file-change', 'started', undefined], ['file-change', 'settled', 'reported-success'],
  ])
  expect(items.map(item => item.patchProcedure)).toEqual([
    { kind: 'patch', changes: [{ operation: 'update', path: 'src/a.ts' }] }, { kind: 'patch', changes: [{ operation: 'update', path: 'src/a.ts' }] },
    { kind: 'patch', changes: [{ operation: 'add', path: 'src/b.ts' }] }, { kind: 'patch', changes: [{ operation: 'add', path: 'src/b.ts' }] },
  ])
  expect(items.every(item => item.procedure === undefined)).toBe(true)
  expect(JSON.stringify(items)).not.toMatch(/native-private-diff|Authorization|"diff"/)
  await lease.release(read()); await f.owner.close()
})
it('never attributes previous-turn notifications to the admitted sequential task', async () => {
  const f = await fixture(false, { observedReads: true, staleRead: true }); const lease = await f.acquire()
  const items: SkillLearningNativeItem[] = []
  const request: ObservedTurnRequest = { source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {},
    onNativeTurn: async () => {}, onNativeItem: async (item) => { items.push(item) } }
  await expect(lease.resumeOriginal(request)).rejects.toThrow(/native|turn|observ/i)
  expect(items).toEqual([]); await f.owner.close()
})
