/** Real Loader and synthetic native leases exercise service inventory, root authority and scoped discovery. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as Sessions from '@deepseek-ai/dsh-session'
import * as Projection from '@deepseek-ai/dsh-session-projection'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Prompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Loop from '@deepseek-ai/dsh-agent-loop'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished, vi } from 'vitest'
import CodingSessions from '../src/index.ts'
import * as Coding from '../src/index.ts'
import { CodingSessionLibrary } from '../src/library.ts'
import { codingSessionDomain } from '../src/record.ts'
import { codingSessionHandoffDomain } from '../src/handoff-record.ts'
import { codingSessionLinkDomain } from '../src/linked-import-record.ts'
import type { CodingSessionProvider, CodingSessionSnapshot, CodingSessionClaimAcknowledgement, CodingSessionHandoff } from '../src/types.ts'

async function fixture(
  config: Partial<Coding.Config> = {},
  modes: { agents?: boolean; workspace?: boolean; beforeStart?: (ctx: Context) => void } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'y-coding-entry-state-')); const ctx = new Context()
  onTestFinished(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  const project = join(root, 'project'); await mkdir(project)
  const source: CodingSessionSnapshot['source'] = { provider: 'codex', profileId: brandString<CodingSessionSnapshot['source']['profileId']>('entry-profile'), nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('entry-original') }
  let history: CodingSessionSnapshot = { source, title: 'Entry fixture', cwd: project, cursor: 'entry-0', writerState: 'idle', events: [] }
  let resumed = 0
  const provider: CodingSessionProvider = { provider: 'codex', profileId: source.profileId, label: 'Entry source', connected: () => true,
    discover: async () => ({ items: [structuredClone(history)] }), read: async () => structuredClone(history),
    sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: 'conversation', acquire: async selected => ({
      source: selected, read: async () => structuredClone(history), resumeOriginal: async (request) => {
        await request.beforeDispatch(); resumed++
        history = { ...history, cursor: `entry-${resumed}`, events: [...history.events,
          { id: brandString<CodingSessionSnapshot['events'][number]['id']>(`entry-user-${resumed}`), role: 'user', text: request.text, digest: `entry-user-digest-${resumed}` }] }
        return { nativeTurnId: brandString<import('../src/types.ts').CodingSessionNativeTurnId>(`entry-turn-${resumed}`) }
      }, release: async () => ({ source: selected, snapshot: structuredClone(history), processExited: true, streamsDrained: true,
        expectedPrefixPersisted: true, completedTurnPersisted: resumed > 0, nativeTurnIds: Array.from({ length: resumed }, (_, index) => brandString<import('../src/types.ts').CodingSessionNativeTurnId>(`entry-turn-${index + 1}`)), noObservedPersistenceErrors: true }),
    }) } }
  const entries: [string, unknown][] = [['storage', Storage], ['storage-json', JsonStorage], ['storage-domain', Domain], ['typert-registry', Typert]]
  if (modes.agents || modes.workspace) entries.push(['session', Sessions], ['session-projection', Projection])
  if (modes.agents) entries.push(['llm', Llm], ['system-prompt', Prompt], ['tools', Tools], ['agent', Agents], ['agent-loop', Loop])
  if (modes.workspace) entries.push(['session-persistence-jsonl', Jsonl], ['workspace', Workspace])
  entries.push(['coding-session', Coding])
  const modules = new Map(entries.map(([name, value]): [string, unknown] => [`@deepseek-ai/dsh-${name}`, value]))
  const configs: Record<string, object> = { 'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' }, 'agent-loop': { agents: [] },
    'coding-session': { enableClaudeDiscovery: false, enableSequentialHandoff: true, ...config } }
  const path = join(root, 'cordis.yml'); await writeFile(path, JSON.stringify([...modules.keys()].map(name => ({ name, config: configs[name.replace('@deepseek-ai/dsh-', '')] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Entry fixture requires Loader resolution')
  ctx.loader.internal = new Proxy(internal, { get(target, property, receiver): unknown {
    if (property === 'import') return async (specifier: string) => { if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`); return modules.get(specifier) }
    return Reflect.get(target, property, receiver)
  } })
  modes.beforeStart?.(ctx)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-coding-session')
  if (entry?.fiber === undefined) throw new Error('Coding fixture fiber is absent')
  await entry.fiber.await()
  const coding = ctx.codingSessions
  return { ctx, coding, root, project, source, provider, fiber: entry.fiber,
    setHistory: (value: CodingSessionSnapshot) => { history = value }, history: () => structuredClone(history), resumed: () => resumed,
    importMirror: async () => { coding.registerProvider(provider); return coding.importSession(source) },
    acknowledgement: (mirror: Awaited<ReturnType<CodingSessions['importSession']>>, rootId: Sessions.SessionId): CodingSessionClaimAcknowledgement => ({ source, project, expectedRevision: mirror.revision, executionSessionId: rootId, externalWritersClosed: true, nativeProfileUnchanged: true }) }
}

// Failure to clear service-owned handles on disposal would expose stale inventory or import storage.
it('refuses mirror and linked operations after its owned storage has closed', async () => {
  const f = await fixture(); const coding = f.coding; await f.fiber.dispose()
  await expect(coding.getState()).rejects.toThrow(/storage is not ready/)
  await expect(coding.linkedDetail(brandString<import('../src/linked-import-types.ts').CodingSessionLinkId>('missing-link'))).rejects.toThrow(/Linked import storage is not ready/)
})
it('refuses duplicate profile registration and preserves one source after idempotent removal', async () => {
  const f = await fixture(); const remove = f.coding.registerProvider(f.provider)
  expect(() => f.coding.registerProvider({ ...f.provider })).toThrow(/already registered/)
  expect((await f.coding.getState()).sources).toHaveLength(1)
  await remove(); await remove(); expect((await f.coding.getState()).sources).toEqual([])
})
it('refuses a destination creation when the selected native source has no project', async () => {
  const f = await fixture(); const { cwd: _cwd, ...unknownProject } = f.history(); f.setHistory(unknownProject)
  const mirror = await f.importMirror()
  await expect(f.coding.createImportDestination(mirror.id)).rejects.toThrow(/native project is unknown/)
})
it('joins cancellation even when no ordinary-Y capabilities are installed', async () => {
  const f = await fixture(); await f.coding.cancelPending(); expect((await f.coding.getState()).sources).toEqual([])
})

// Selecting a different root after a reviewed mirror read must invalidate the acquisition.
it('refuses sequential handoff while deployment-owned handoff is disabled', async () => {
  const f = await fixture({ enableSequentialHandoff: false }); const mirror = await f.importMirror()
  await expect(f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, Sessions.SessionId('missing-root')))).rejects.toThrow(/handoff is disabled/)
  expect(f.resumed()).toBe(0)
})
it('refuses claims without a selected live root in the exact native project', async () => {
  const f = await fixture(); const mirror = await f.importMirror()
  await expect(f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, Sessions.SessionId('missing-root')))).rejects.toThrow(/idle live Y root/)
  expect(f.resumed()).toBe(0)
})
it('lists only known idle live root projects and enforces complete inventory limits', async () => {
  const f = await fixture({}, { agents: true })
  const root = await f.ctx.agentLoop.create(Sessions.SessionId('entry-live-root'), { provider: 'fixture', model: 'fixture' }, { cwd: f.project })
  await f.ctx.agentLoop.create(Sessions.SessionId('entry-project-unknown'), { provider: 'fixture', model: 'fixture' })
  expect((await f.coding.getState()).executionSessions).toEqual([{ id: root.id, project: f.project }])
})
it.each(['count', 'bytes'] as const)('refuses complete execution inventory over its %s limit', async (limit) => {
  const f = await fixture(limit === 'count' ? { maxMirrors: 1 } : { maxBytes: 1000 }, { agents: true })
  await f.ctx.agentLoop.create(Sessions.SessionId('entry-limit-one'), { provider: 'fixture', model: 'fixture' }, { cwd: limit === 'count' ? f.project : '/fixture/' + 'a'.repeat(1500) })
  if (limit === 'count') await f.ctx.agentLoop.create(Sessions.SessionId('entry-limit-two'), { provider: 'fixture', model: 'fixture' }, { cwd: f.project })
  await expect(f.coding.getState()).rejects.toThrow(/execution and import inventory exceeded/)
})
it('continues only the captured exact root without invoking an absent skill service', async () => {
  const f = await fixture({}, { agents: true }); const agent = await f.ctx.agentLoop.create(Sessions.SessionId('entry-claim-root'), { provider: 'fixture', model: 'fixture' }, { cwd: f.project })
  const mirror = await f.importMirror(); const claimed = await f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, agent.id))
  const continued = await f.coding.continueSequential(mirror.id, 'Synthetic continuation', claimed.revision)
  expect(continued.events.map(event => event.text)).toEqual(['Synthetic continuation']); expect(f.resumed()).toBe(1)
  await f.coding.releaseSequential(mirror.id)
  await expect(f.coding.continueSequential(mirror.id, 'Unclaimed synthetic continuation', continued.revision)).rejects.toThrow(/selected Y execution session changed/)
  expect(f.resumed()).toBe(1)
})
it('refuses another claim while the exact source owner remains held', async () => {
  const f = await fixture({}, { agents: true }); const agent = await f.ctx.agentLoop.create(Sessions.SessionId('entry-held-root'), { provider: 'fixture', model: 'fixture' }, { cwd: f.project })
  const mirror = await f.importMirror(); await f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, agent.id))
  await expect(f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, agent.id))).rejects.toThrow(/ownership is unresolved/)
  expect(f.resumed()).toBe(0); await f.coding.releaseSequential(mirror.id)
})
it('revalidates root identity after asynchronous mirror read before claiming', async () => {
  const f = await fixture({}, { agents: true }); const agent = await f.ctx.agents.create({ sessionId: Sessions.SessionId('entry-replaced-root'), agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: f.project } })
  const mirror = await f.importMirror(); const detail = f.coding.detail.bind(f.coding)
  const observing = vi.spyOn(CodingSessionLibrary.prototype, 'detail').mockImplementation(async (id) => {
    observing.mockRestore(); const value = await detail(id); await agent.dispose()
    await f.ctx.agentLoop.create(agent.agent.id, { provider: 'fixture', model: 'fixture' }, { cwd: f.project }); return value
  })
  await expect(f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, agent.agent.id))).rejects.toThrow(/changed before acquisition/)
  expect(f.resumed()).toBe(0)
})

// Workspace membership and pinned profile directory delimit the discovery source without invoking SDK history reads.
it('discovers each registered Claude project once and withdraws deleted projects', async () => {
  const f = await fixture({ enableClaudeDiscovery: true }, { workspace: true }); const project = await f.ctx.workspaceRegistry.create(f.project, 'Fixture project')
  const first = await f.coding.getState(); expect(first.sources.map(value => value.label)).toEqual(['Claude Code · Fixture project'])
  expect(first.sources[0]?.connected).toBe(true); expect((await f.coding.getState()).sources).toEqual(first.sources)
  await f.ctx.workspaceRegistry.delete(project.id)
  expect((await f.coding.getState()).sources).toEqual([])
})
it('refuses discovering projects when the pinned native profile directory changes', async () => {
  const f = await fixture({ enableClaudeDiscovery: true }); vi.stubEnv('CLAUDE_CONFIG_DIR', join(f.root, 'another-native-profile'))
  await expect(f.coding.getState()).rejects.toThrow(/native Claude profile directory changed/)
})
it('permits an empty project registry using the default native profile directory', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  const f = await fixture({ enableClaudeDiscovery: true }); expect((await f.coding.getState()).sources).toEqual([])
})

it('preserves provider registration admitted while the mirror domain is still opening', async () => {
  let earlyProvider: CodingSessionProvider | undefined
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the actual facility receiver.
  const open = Domain.DomainFacility.prototype.open
  const f = await fixture({}, { beforeStart(ctx) {
    vi.spyOn(Domain.DomainFacility.prototype, 'open').mockImplementation(async function<S extends Domain.DomainSpec>(this: Domain.DomainFacility, spec: S): Promise<Domain.Domain<S>> {
      if (spec.name === codingSessionDomain.name) {
        const coding = ctx.get('codingSessions', false)
        if (coding === undefined) throw new Error('Pending service constructor was not registered')
        earlyProvider = { provider: 'codex', profileId: brandString<CodingSessionProvider['profileId']>('opening-profile'), label: 'Opening source',
          connected: () => true, discover: async () => ({ items: [] }), read: async () => { throw new Error('No history read in opening fixture') } }
        coding.registerProvider(earlyProvider)
      }
      return Reflect.apply(open, this, [spec])
    })
  } })
  expect((await f.coding.getState()).sources.map(value => value.label)).toEqual(['Opening source'])
  expect(earlyProvider).toBeDefined()
})
it('removes a pending provider before library setup without leaving a duplicate profile', async () => {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  const coding = new CodingSessions(ctx)
  const provider: CodingSessionProvider = { provider: 'codex', profileId: brandString<CodingSessionProvider['profileId']>('pending-profile'),
    label: 'Pending source', connected: () => true, discover: async () => ({ items: [] }), read: async () => { throw new Error('No unready history reads') } }
  const remove = coding.registerProvider(provider); const removed = remove()
  expect(remove()).toBe(removed); await removed
  expect(() => coding.registerProvider(provider)).not.toThrow()
  await expect(coding.getState()).rejects.toThrow(/storage is not ready/)
})
it('refuses destination creation if service disposal completes during the selected mirror read', async () => {
  const f = await fixture(); const mirror = await f.importMirror(); const detail = f.coding.detail.bind(f.coding)
  const observing = vi.spyOn(CodingSessionLibrary.prototype, 'detail').mockImplementation(async (id) => {
    observing.mockRestore(); const value = await detail(id); await f.fiber.dispose(); return value
  })
  await expect(f.coding.createImportDestination(mirror.id)).rejects.toThrow(/Import destination storage is not ready/)
  expect(f.ctx.storageDomain.get(codingSessionDomain.name)).toBeUndefined()
})
it('acknowledges a durably interrupted native owner without sending a continuation', async () => {
  const f = await fixture(); const mirror = await f.importMirror()
  const handoffs = f.ctx.storageDomain.get(codingSessionHandoffDomain.name)
  if (handoffs === undefined) throw new Error('Handoff journal is absent')
  const marker: CodingSessionHandoff = { id: mirror.id, ownerToken: brandString<CodingSessionHandoff['ownerToken']>('lost-fixture-owner'),
    source: f.source, project: f.project, executionSessionId: Sessions.SessionId('old-root'), expectedRevision: mirror.revision,
    phase: 'blocked-uncertain', toolMode: 'conversation', nativeProfileUnchanged: true, externalWritersClosed: true,
    dispatchedTurnCount: 0, nativeTurnIds: [] }
  await handoffs.table('markers').put(mirror.id, marker)
  const recovered = await f.coding.recoverSequential(mirror.id, { source: f.source, project: f.project,
    expectedRevision: mirror.revision, expectedOwnerToken: marker.ownerToken, nativeProfileUnchanged: true,
    externalWritersClosed: true, acceptUnresolvedTurns: false })
  expect(recovered.handoff?.phase).toBe('recovered-acknowledged')
  expect(recovered.handoff?.recoveryHistory?.[0]?.oldProcessExit).toBe('not-observed'); expect(f.resumed()).toBe(0)
})
it('joins other domains when linked journal close reports a storage failure', async () => {
  const f = await fixture(); const links = f.ctx.storageDomain.get(codingSessionLinkDomain.name)
  if (links === undefined) throw new Error('Linked journal is absent')
  const close = links.close.bind(links)
  vi.spyOn(links, 'close').mockImplementation(async () => { await close(); throw new Error('Fixture link close failed') })
  await f.fiber.dispose()
  expect(f.ctx.storageDomain.get(codingSessionDomain.name)).toBeUndefined()
  expect(f.ctx.storageDomain.get(codingSessionHandoffDomain.name)).toBeUndefined()
  expect(f.ctx.storageDomain.get(codingSessionLinkDomain.name)).toBeUndefined()
  expect(f.ctx.logger.buffer.some(entry => entry.args.some(value => value instanceof Error && value.message === 'Fixture link close failed'))).toBe(true)
})
it('reports setup failure together with uncertain cleanup after draining opened storage', async () => {
  let observed: Context | undefined
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the actual facility receiver.
  const open = Domain.DomainFacility.prototype.open
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the actual library receiver.
  const close = CodingSessionLibrary.prototype.close
  await expect(fixture({}, { beforeStart(ctx) {
    observed = ctx
    vi.spyOn(Domain.DomainFacility.prototype, 'open').mockImplementation(async function<S extends Domain.DomainSpec>(this: Domain.DomainFacility, spec: S): Promise<Domain.Domain<S>> {
      if (spec.name === codingSessionLinkDomain.name) throw new Error('Fixture link medium unavailable')
      return Reflect.apply(open, this, [spec])
    })
    vi.spyOn(CodingSessionLibrary.prototype, 'close').mockImplementation(async function(this: CodingSessionLibrary) {
      await Reflect.apply(close, this, []); throw new Error('Fixture release remains uncertain')
    })
  } })).rejects.toThrow(/setup failed.*cleanup remains uncertain/)
  if (observed === undefined) throw new Error('Setup context was not observed')
  expect(observed.storageDomain.get(codingSessionDomain.name)).toBeUndefined()
  expect(observed.storageDomain.get(codingSessionHandoffDomain.name)).toBeUndefined()
})
it('withdraws a deleted Claude profile and reports a failed native release', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the actual library receiver.
  const register = CodingSessionLibrary.prototype.register
  vi.spyOn(CodingSessionLibrary.prototype, 'register').mockImplementation(function(this: CodingSessionLibrary, provider) {
    const dispose = Reflect.apply(register, this, [provider])
    return async () => { await dispose(); throw new Error('Fixture Claude release uncertain') }
  })
  const f = await fixture({ enableClaudeDiscovery: true }, { workspace: true })
  const project = await f.ctx.workspaceRegistry.create(f.project, 'Withdrawn fixture')
  expect((await f.coding.getState()).sources).toHaveLength(1)
  await f.ctx.workspaceRegistry.delete(project.id); expect((await f.coding.getState()).sources).toEqual([])
  await expect.poll(() => f.ctx.logger.buffer.some(entry => entry.args.some(value => value instanceof Error && value.message === 'Fixture Claude release uncertain'))).toBe(true)
})
it('invalidates retained discovery readiness when its Workspace service unloads', async () => {
  const registered = vi.spyOn(CodingSessionLibrary.prototype, 'register')
  const f = await fixture({ enableClaudeDiscovery: true }, { workspace: true })
  await f.ctx.workspaceRegistry.create(f.project, 'Fixture workspace lifetime'); await f.coding.getState()
  const provider = registered.mock.calls[0]?.[0]
  if (provider === undefined) throw new Error('Actual project provider was not registered')
  const workspace = [...f.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-workspace')?.fiber
  if (workspace === undefined) throw new Error('Workspace fiber is absent')
  expect(provider.connected()).toBe(true); await workspace.dispose(); expect(provider.connected()).toBe(false)
  expect((await f.coding.getState()).sources).toEqual([])
})

it('drains every journal when an owned profile disposer throws synchronously', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the actual library receiver.
  const register = CodingSessionLibrary.prototype.register
  vi.spyOn(CodingSessionLibrary.prototype, 'register').mockImplementation(function(this: CodingSessionLibrary, provider) {
    Reflect.apply(register, this, [provider])
    return () => { throw new Error('Fixture profile disposer threw') }
  })
  const f = await fixture(); f.coding.registerProvider(f.provider)
  await f.fiber.dispose()
  expect(f.ctx.storageDomain.get(codingSessionDomain.name)).toBeUndefined()
  expect(f.ctx.storageDomain.get(codingSessionHandoffDomain.name)).toBeUndefined()
  expect(f.ctx.storageDomain.get(codingSessionLinkDomain.name)).toBeUndefined()
  expect(f.ctx.logger.buffer.some(entry => entry.args.some(value => value instanceof Error && value.message === 'Fixture profile disposer threw'))).toBe(true)
})
it('refuses a claim in another project without acquiring the synthetic native writer', async () => {
  const f = await fixture({}, { agents: true })
  const root = await f.ctx.agentLoop.create(Sessions.SessionId('entry-other-project'), { provider: 'fixture', model: 'fixture' }, { cwd: f.project })
  const mirror = await f.importMirror()
  await expect(f.coding.claimSequential(mirror.id, { ...f.acknowledgement(mirror, root.id), project: '/fixture/other-project' })).rejects.toThrow(/exact native project/)
  expect(f.resumed()).toBe(0)
})
it('refuses continuation after disposal of its captured root during mirror read, then permits independent release', async () => {
  const f = await fixture({}, { agents: true })
  const root = await f.ctx.agents.create({ sessionId: Sessions.SessionId('entry-disposed-owner'), agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: f.project } })
  const mirror = await f.importMirror(); const claimed = await f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, root.agent.id))
  const detail = f.coding.detail.bind(f.coding)
  const observing = vi.spyOn(CodingSessionLibrary.prototype, 'detail').mockImplementation(async (id) => {
    observing.mockRestore(); const value = await detail(id); await root.dispose(); return value
  })
  await expect(f.coding.continueSequential(mirror.id, 'Synthetic refused continuation', claimed.revision)).rejects.toThrow(/idle live Y root/)
  expect(f.resumed()).toBe(0); expect((await f.coding.releaseSequential(mirror.id)).handoff?.phase).toBe('external-ready')
})
it('refuses a stale captured root after claim of a read-only native source fails before ownership admission', async () => {
  const f = await fixture({}, { agents: true })
  const root = await f.ctx.agentLoop.create(Sessions.SessionId('entry-read-only-root'), { provider: 'fixture', model: 'fixture' }, { cwd: f.project })
  const { sequentialWriter: _writer, ...reader } = f.provider
  f.coding.registerProvider(reader); const mirror = await f.coding.importSession(f.source)
  await expect(f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, root.id))).rejects.toThrow()
  await expect(f.coding.continueSequential(mirror.id, 'Synthetic refused continuation', mirror.revision)).rejects.toThrow(/selected Y execution session changed/)
  expect(f.resumed()).toBe(0)
})
it('refuses continuation when a different root replaces the captured owner during mirror read', async () => {
  const f = await fixture({}, { agents: true })
  const root = await f.ctx.agents.create({ sessionId: Sessions.SessionId('entry-replaced-owner'), agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: f.project } })
  const mirror = await f.importMirror(); const claimed = await f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, root.agent.id))
  const detail = f.coding.detail.bind(f.coding); const enter = vi.spyOn(f.ctx.agents, 'withInitiator')
  const observing = vi.spyOn(CodingSessionLibrary.prototype, 'detail').mockImplementation(async (id) => {
    observing.mockRestore(); const value = await detail(id); await root.dispose()
    await f.ctx.agentLoop.create(root.agent.id, { provider: 'fixture', model: 'fixture' }, { cwd: f.project }); return value
  })
  await expect(f.coding.continueSequential(mirror.id, 'Synthetic refused continuation', claimed.revision)).rejects.toThrow(/selected Y execution session changed/)
  expect(enter).not.toHaveBeenCalled(); expect(f.resumed()).toBe(0)
  expect((await f.coding.releaseSequential(mirror.id)).handoff?.phase).toBe('external-ready')
})
it('enters exact root policy only after reviewed native detail settles and before lease acquisition', async () => {
  const f = await fixture({}, { agents: true })
  const root = await f.ctx.agentLoop.create(Sessions.SessionId('entry-policy-order'), { provider: 'fixture', model: 'fixture' }, { cwd: f.project })
  const mirror = await f.importMirror(); const expectedRoot = f.ctx.agents.get(root.id)
  const writer = f.provider.sequentialWriter
  if (expectedRoot === undefined || writer === undefined) throw new Error('Policy fixture root or writer is absent')
  const order: string[] = []; const detail = f.coding.detail.bind(f.coding); const acquire = writer.acquire.bind(writer)
  const observing = vi.spyOn(CodingSessionLibrary.prototype, 'detail').mockImplementation(async (id) => {
    observing.mockRestore(); order.push('detail-start'); const value = await detail(id); order.push('detail-settled'); return value
  })
  vi.spyOn(writer, 'acquire').mockImplementation(async (source, request) => {
    expect(f.ctx.agents.requireInitiator()).toBe(expectedRoot); order.push('native-acquire')
    return acquire(source, request)
  })
  const claimed = await f.coding.claimSequential(mirror.id, f.acknowledgement(mirror, root.id))
  expect(order).toEqual(['detail-start', 'detail-settled', 'native-acquire'])
  expect(claimed.handoff).toMatchObject({ phase: 'y-owned', executionSessionId: root.id, project: f.project })
  expect(f.ctx.agents.roots()).toHaveLength(1); expect(f.resumed()).toBe(0)
  await f.coding.releaseSequential(mirror.id)
})
