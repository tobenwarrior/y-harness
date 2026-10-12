/** Actual Loader and JSON domains exercise scoped partial setup and settled failed teardown. No native processes run. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as CodingSessions from '../src/index.ts'
import { CodingSessionLibrary } from '../src/library.ts'
import { codingSessionDomain } from '../src/record.ts'
import { codingSessionHandoffDomain } from '../src/handoff-record.ts'
import type { CodingSessionClaimAcknowledgement, CodingSessionHandoff, CodingSessionProvider, CodingSessionSnapshot } from '../src/types.ts'

let context: Context | undefined
let root: string | undefined
afterEach(async () => {
  // Restore injected faults before disposing the wider storage facility.
  vi.restoreAllMocks()
  await context?.fiber.dispose(); context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function bootStorage(extraModules: readonly [string, unknown][] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'y-coding-session-lifecycle-'))
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', JsonStorage],
    ['@deepseek-ai/dsh-storage-domain', Domain], ['@deepseek-ai/dsh-typert-registry', Typert],
    ['@deepseek-ai/dsh-coding-session', CodingSessions],
    ...extraModules,
  ])
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Fixture needs Loader module resolution')
  ctx.loader.internal = new Proxy(internal, { get(target, property, receiver): unknown {
    if (property === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected fixture module')
      return modules.get(specifier)
    }
    return Reflect.get(target, property, receiver)
  } })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-storage' })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-typert-registry' })
  await ctx.loader.await()
  return ctx
}
async function startCodingSessions(ctx: Context) {
  const id = await ctx.loader.create({ name: '@deepseek-ai/dsh-coding-session', config: { enableClaudeDiscovery: false, enableSequentialHandoff: true } })
  const fiber = ctx.loader.resolve(id).fiber
  if (fiber === undefined) throw new Error('Coding session fixture did not create a Loader fiber')
  return fiber
}
const marker: CodingSessionHandoff = {
  id: brandString<CodingSessionHandoff['id']>('unresolved-mirror'), ownerToken: brandString<CodingSessionHandoff['ownerToken']>('recorded-owner'),
  source: { provider: 'claude', profileId: brandString<CodingSessionHandoff['source']['profileId']>('fixture-profile'), nativeSessionId: brandString<CodingSessionHandoff['source']['nativeSessionId']>('original-native-id') },
  project: '/fixture/project', executionSessionId: brandString<CodingSessionHandoff['executionSessionId']>('root-fixture'),
  expectedRevision: 1, phase: 'blocked-uncertain', toolMode: 'conversation', nativeProfileUnchanged: true, externalWritersClosed: true,
  dispatchedTurnCount: 1, nativeTurnIds: [],
}

describe('coding session scoped Loader lifecycle', () => {
  it('joins profile-scoped release before an actual source fiber closes, including failure and a second draining lease', async () => {
    const entered = deferred(); const settle = deferred(); let ownerClosed = false; let failFirst = true
    const releases: string[] = []
    const snapshot = (id: string, profileId = 'source-profile'): CodingSessionSnapshot => ({
      source: { provider: 'claude', profileId: brandString<CodingSessionSnapshot['source']['profileId']>(profileId), nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>(id) },
      title: 'Fixture original conversation', cwd: '/fixture/project', writerState: 'unknown', events: [], cursor: id,
    })
    const provider: CodingSessionProvider = { provider: 'claude', profileId: snapshot('one').source.profileId,
      label: 'Owned profile', connected: () => !ownerClosed, discover: async () => ({ items: [] }),
      read: async id => snapshot(id), sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: 'conversation',
        acquire: async source => ({ source, read: async () => snapshot(source.nativeSessionId),
          resumeOriginal: async () => { throw new Error('No model turns in lifecycle fixture') },
          release: async () => {
            releases.push(source.nativeSessionId)
            if (source.nativeSessionId === 'one' && failFirst) throw new Error('Fixture original persistence remains uncertain')
            if (source.nativeSessionId === 'two') { entered.resolve(); await settle.promise }
            return { source, snapshot: snapshot(source.nativeSessionId), processExited: true, streamsDrained: true,
              expectedPrefixPersisted: true, completedTurnPersisted: false, nativeTurnIds: [], noObservedPersistenceErrors: true }
          },
        }),
      },
    }
    let unregister: (() => Promise<void>) | undefined
    // Observe the actual service-owned library without replacing its storage, queue or release implementation.
    const registration = vi.spyOn(CodingSessionLibrary.prototype, 'register')
    const sourcePlugin = { name: 'fixture-native-source', inject: ['codingSessions'], apply(ctx: Context) {
      ctx.effect(() => {
        const dispose = unregister = ctx.codingSessions.registerProvider(provider)
        return async () => { try { await dispose() } finally { ownerClosed = true } }
      }, 'fixture-native-source: profile release before reader closure')
    } }
    const ctx = await bootStorage([['fixture-native-source', sourcePlugin]])
    const coding = await startCodingSessions(ctx); await coding.await()
    const sourceId = await ctx.loader.create({ name: 'fixture-native-source' })
    const sourceFiber = ctx.loader.resolve(sourceId).fiber
    if (sourceFiber === undefined) throw new Error('Fixture source fiber is absent')
    await sourceFiber.await()
    const observed = registration.mock.contexts[0]
    if (!(observed instanceof CodingSessionLibrary) || unregister === undefined) {
      throw new Error('Fixture source registration was not observed')
    }
    const ownedLibrary = observed; const remove = unregister
    const acknowledgement = (value: Awaited<ReturnType<CodingSessionLibrary['importSession']>>): CodingSessionClaimAcknowledgement => ({
      source: value.source, project: '/fixture/project', expectedRevision: value.revision,
      executionSessionId: brandString<CodingSessionClaimAcknowledgement['executionSessionId']>('fixture-root'), externalWritersClosed: true, nativeProfileUnchanged: true,
    })
    const first = await ctx.codingSessions.importSession(snapshot('one').source)
    const second = await ctx.codingSessions.importSession(snapshot('two').source)
    let unrelatedReleases = 0
    const unrelated = snapshot('other', 'unrelated-profile')
    const removeUnrelated = ctx.codingSessions.registerProvider({ ...provider, profileId: unrelated.source.profileId,
      label: 'Unrelated profile', connected: () => true, read: async () => unrelated,
      sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: 'conversation', acquire: async source => ({
        source, read: async () => unrelated, resumeOriginal: async () => { throw new Error('No fixture model turns') },
        release: async () => { unrelatedReleases++; return { source, snapshot: unrelated, processExited: true, streamsDrained: true,
          expectedPrefixPersisted: true, completedTurnPersisted: false, nativeTurnIds: [], noObservedPersistenceErrors: true } },
      }) },
    })
    const third = await ctx.codingSessions.importSession(unrelated.source)
    // Root authority admission is covered by the native executor's separate real-root fixture.
    await ownedLibrary.claimSequential(first.id, acknowledgement(first))
    await ownedLibrary.claimSequential(second.id, acknowledgement(second))
    await ownedLibrary.claimSequential(third.id, acknowledgement(third))
    let settled = false
    const pending = sourceFiber.dispose().then(() => { settled = true })
    await entered.promise
    try {
      const releaseQueue = remove()
      expect(remove()).toBe(releaseQueue)
      expect((await ctx.codingSessions.getState()).sources.map(value => value.profileId)).toEqual([unrelated.source.profileId])
      expect(ownerClosed).toBe(false); expect(settled).toBe(false)
      expect(unrelatedReleases).toBe(0)
      expect((await ctx.codingSessions.detail(first.id)).handoff?.phase).toBe('blocked-uncertain')
      expect((await ctx.codingSessions.detail(second.id)).handoff?.phase).toBe('releasing')
    } finally { settle.resolve(); await pending }
    expect(releases).toEqual(['one', 'two']); expect(ownerClosed).toBe(true)
    expect(unrelatedReleases).toBe(0); expect((await ctx.codingSessions.detail(third.id)).handoff?.phase).toBe('y-owned')
    await expect(remove()).rejects.toThrow('release remains uncertain')
    expect((await ctx.codingSessions.detail(first.id)).handoff?.phase).toBe('blocked-uncertain')
    expect((await ctx.codingSessions.detail(second.id)).handoff?.phase).toBe('external-ready')
    const journal = await readFile(join(root!, 'storage', 'coding_session_handoffs.json'), 'utf8')
    expect(journal).toContain('blocked-uncertain'); expect(journal).toContain('external-ready')
    failFirst = false
    await ctx.codingSessions.releaseSequential(first.id)
    await ctx.codingSessions.releaseSequential(third.id); await removeUnrelated()
  })

  it('rolls back the mirror domain when the second domain fails to open', async () => {
    const ctx = await bootStorage()
    const open = ctx.storageDomain.open.bind(ctx.storageDomain)
    const opening = vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async function<S extends Domain.DomainSpec>(spec: S): Promise<Domain.Domain<S>> {
      if (spec.name === codingSessionHandoffDomain.name) throw new Error('Handoff medium unavailable')
      return open(spec)
    })
    const fiber = await startCodingSessions(ctx)
    await expect(fiber.await()).rejects.toThrow('Handoff medium unavailable')
    expect(ctx.storageDomain.get(codingSessionDomain.name)).toBeUndefined()
    expect(ctx.storageDomain.get(codingSessionHandoffDomain.name)).toBeUndefined()
    opening.mockRestore()
    const reopened = await ctx.storageDomain.open(codingSessionDomain)
    await reopened.close()
  })

  it('joins disposal during asynchronous setup and closes every acquired handle', async () => {
    const ctx = await bootStorage()
    const open = ctx.storageDomain.open.bind(ctx.storageDomain)
    const entered = deferred(); const settle = deferred()
    const opening = vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async function<S extends Domain.DomainSpec>(spec: S): Promise<Domain.Domain<S>> {
      const handle = await open(spec)
      if (spec.name === codingSessionHandoffDomain.name) { entered.resolve(); await settle.promise }
      return handle
    })
    const fiber = await startCodingSessions(ctx)
    await entered.promise
    expect(ctx.storageDomain.get(codingSessionDomain.name)).toBeDefined()
    expect(ctx.storageDomain.get(codingSessionHandoffDomain.name)).toBeDefined()
    let disposed = false
    const pending = fiber.dispose().then(() => { disposed = true })
    try { expect(disposed).toBe(false) } finally { settle.resolve(); await pending }
    expect(ctx.storageDomain.get(codingSessionDomain.name)).toBeUndefined()
    expect(ctx.storageDomain.get(codingSessionHandoffDomain.name)).toBeUndefined()
    opening.mockRestore()
    const mirrors = await ctx.storageDomain.open(codingSessionDomain)
    const handoffs = await ctx.storageDomain.open(codingSessionHandoffDomain)
    await handoffs.close(); await mirrors.close()
  })

  it('settles uncertain library cleanup before both domain closes, collects all failures and retains the unresolved journal', async () => {
    const ctx = await bootStorage()
    const fiber = await startCodingSessions(ctx); await fiber.await()
    const mirrors = ctx.storageDomain.get(codingSessionDomain.name)
    const handoffs = ctx.storageDomain.get(codingSessionHandoffDomain.name)
    if (mirrors === undefined || handoffs === undefined) throw new Error('Fixture storage handles are absent')
    await handoffs.table('markers').put(marker.id, marker)
    const entered = deferred(); const settle = deferred(); const order: string[] = []
    const registration = vi.spyOn(CodingSessionLibrary.prototype, 'register')
    const unregister = ctx.codingSessions.registerProvider({
      provider: marker.source.provider, profileId: marker.source.profileId, label: 'Cleanup observer', connected: () => true,
      discover: async () => ({ items: [] }),
      read: async () => ({ source: marker.source, title: 'Observer', writerState: 'unknown', events: [], cursor: 'fixture-observer',
        capabilities: { discover: true, read: true, refresh: true, continue: false, reason: 'native-writer-handoff-unavailable' } }),
    })
    const library = registration.mock.contexts[0]
    if (!(library instanceof CodingSessionLibrary)) throw new Error('Fixture library was not observed')
    await unregister()
    const closeLibrary = library.close.bind(library)
    const closing = vi.spyOn(library, 'close').mockImplementation(async () => {
      order.push('library-entered'); entered.resolve(); await settle.promise
      await closeLibrary(); order.push('library-settled')
      throw new Error('Fixture native release remains uncertain')
    })
    const closeHandoffs = handoffs.close.bind(handoffs)
    vi.spyOn(handoffs, 'close').mockImplementation(async () => {
      order.push('handoffs-close'); await closeHandoffs(); throw new Error('Fixture handoff close reported failure')
    })
    const closeMirrors = mirrors.close.bind(mirrors)
    vi.spyOn(mirrors, 'close').mockImplementation(async () => {
      order.push('mirrors-close'); await closeMirrors(); throw new Error('Fixture mirror close reported failure')
    })
    const pending = fiber.dispose()
    await entered.promise
    try {
      expect(order).toEqual(['library-entered'])
      expect(handoffs.table('markers').get(marker.id)).toEqual(marker)
      expect(ctx.storageDomain.get(codingSessionDomain.name)).toBe(mirrors)
    } finally { settle.resolve(); await pending }
    expect(closing).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['library-entered', 'library-settled', 'handoffs-close', 'mirrors-close'])
    expect(ctx.storageDomain.get(codingSessionDomain.name)).toBeUndefined()
    expect(ctx.storageDomain.get(codingSessionHandoffDomain.name)).toBeUndefined()
    const errors: unknown[] = []
    for (const message of ctx.logger.buffer) if (message.type === 'error') {
      const args: readonly unknown[] = message.args
      errors.push(...args)
    }
    for (const message of ['Fixture native release remains uncertain', 'Fixture handoff close reported failure', 'Fixture mirror close reported failure']) {
      expect(errors.some(error => error instanceof Error && error.message === message)).toBe(true)
    }
    const persisted = await readFile(join(root!, 'storage', 'coding_session_handoffs.json'), 'utf8')
    expect(persisted).toContain('blocked-uncertain'); expect(persisted).toContain('recorded-owner')
    const reopened = await ctx.storageDomain.open(codingSessionHandoffDomain)
    expect(reopened.table('markers').get(marker.id)).toEqual(marker)
    await reopened.close()
  })
})
