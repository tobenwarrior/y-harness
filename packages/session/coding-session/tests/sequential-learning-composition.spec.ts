/** Real Loader task ownership and learning policy; only native transport and conversation output are fixtures. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Sessions from '@deepseek-ai/dsh-session'
import * as Projection from '@deepseek-ai/dsh-session-projection'
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
import * as Library from '@deepseek-ai/dsh-skill-library'
import type { SkillLearningNativeItem, SkillLearningObservation, SkillLearningEvidence, SkillSequentialTaskSource, SkillSequentialTaskHooks, SkillCodexItemId, SkillCodexSessionId, SkillCodexTurnId, SkillNativeConnectionId } from '@deepseek-ai/dsh-skill-library/types'
import { SequentialSkillLearning } from '../../../skill/skill-library/src/sequential-learning.ts'
import type { SkillLearningRuntimeController } from '../../../skill/skill-library/src/learning-runtime.ts'
import * as CodingSessions from '../src/index.ts'
import type { CodingSessionSnapshot, CodingSessionSequentialWriterLease, CodingSessionNativeTurnId, CodingSessionProvider } from '../src/types.ts'

type NativeRequest = Parameters<CodingSessionSequentialWriterLease['resumeOriginal']>[0] & {
  onNativeTurn?(id: string): Promise<void>
  onNativeItem?(item: SkillLearningNativeItem): Promise<void>
}
type Mode = 'reads' | 'reversed-reads' | 'unknown' | 'duplicate' | 'failure' | 'cancellation' | 'claude' | 'patches' | 'reversed-patches'
class ConversationFixture extends Llm.LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<Llm.LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(): AsyncIterable<Llm.StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Earlier ordinary Y task finished.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Earlier ordinary Y task finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function fixture(initialMode: Mode = 'reads') {
  const root = await mkdtemp(join(tmpdir(), 'y-sequential-learning-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const projectPath = join(root, 'project'); await mkdir(join(projectPath, '.git'), { recursive: true })
  const source: CodingSessionSnapshot['source'] = { provider: initialMode === 'claude' ? 'claude' : 'codex',
    profileId: brandString<CodingSessionSnapshot['source']['profileId']>('fixture-native-profile'),
    nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('original-native-session') }
  let mode = initialMode; let count = 0; let held = false; let lastRequest: NativeRequest | undefined
  const entered = deferred(); const resume = deferred()
  let history: CodingSessionSnapshot = { source, title: 'Saved native session', cwd: projectPath, writerState: 'idle',
    cursor: 'native-cursor-0', events: [{ id: brandString<CodingSessionSnapshot['events'][number]['id']>('prior-user'), role: 'user', text: 'Historical task must not become fresh learning.', digest: 'prior-user-digest' }] }
  const completed: CodingSessionNativeTurnId[] = []
  const provider: CodingSessionProvider = { ...source, label: 'Fixture native source', connected: () => true,
    discover: async () => ({ items: [history] }), read: async () => structuredClone(history),
    sequentialWriter: { authority: 'user-acknowledged-sequential', toolMode: source.provider === 'claude' ? 'conversation' : 'project-files',
      acquire: async (selected) => {
        if (held) throw new Error('Fixture native owner already held'); held = true
        return { source: selected, read: async () => structuredClone(history),
          resumeOriginal: async (request: NativeRequest) => {
            lastRequest = request
            await request.beforeDispatch(); request.signal.throwIfAborted(); count++
            const nativeTurn = `current-native-turn-${count}`
            await request.onNativeTurn?.(nativeTurn)
            if (mode === 'cancellation') { entered.resolve(); await resume.promise; request.signal.throwIfAborted() }
            if (mode === 'failure') throw new Error('Fixture native persistence uncertain')
            if (source.provider === 'codex') {
              const paths = mode === 'reversed-reads' || mode === 'reversed-patches' ? ['src/b.ts', 'src/a.ts'] : ['src/a.ts', 'src/b.ts']
              for (const [index, path] of paths.entries()) {
                const patchMode = mode === 'patches' || mode === 'reversed-patches'
                const identity = { provider: 'codex' as const, connectionId: brandString<SkillNativeConnectionId>('fixture-native-profile'),
                  sessionId: brandString<SkillCodexSessionId>('original-native-session'), turnId: brandString<SkillCodexTurnId>(nativeTurn),
                  itemId: brandString<SkillCodexItemId>(`${nativeTurn}-read-${index}`), kind: patchMode ? 'file-change' as const : 'read' as const, name: patchMode ? 'native-file-change' : 'native-read',
                  ...mode === 'unknown' ? {} : patchMode
                    ? { patchProcedure: { kind: 'patch' as const, changes: [{ operation: 'update' as const, path }] } }
                    : { procedure: { kind: 'read' as const, path } } }
                const started: SkillLearningNativeItem = { ...identity, phase: 'started' }
                await request.onNativeItem?.(started)
                if (mode === 'duplicate') await request.onNativeItem?.(started)
                await request.onNativeItem?.({ ...identity, phase: 'settled', outcome: 'reported-success' })
              }
            }
            const id = brandString<CodingSessionNativeTurnId>(nativeTurn); completed.push(id)
            history = { ...history, cursor: `native-cursor-${count}`, events: [...history.events,
              { id: brandString<CodingSessionSnapshot['events'][number]['id']>(`${nativeTurn}-user`), role: 'user', text: request.text, digest: `${nativeTurn}-user-digest` },
              { id: brandString<CodingSessionSnapshot['events'][number]['id']>(`${nativeTurn}-assistant`), role: 'assistant', text: 'Unverified native answer.', digest: `${nativeTurn}-assistant-digest` }] }
            return { nativeTurnId: id }
          }, release: async () => { held = false; return { source: selected, snapshot: structuredClone(history), processExited: true,
            streamsDrained: true, expectedPrefixPersisted: true, completedTurnPersisted: completed.length > 0,
            nativeTurnIds: [...completed], noObservedPersistenceErrors: true } },
        }
      },
    },
  }
  const nativePlugin = { name: 'fixture-sequential-source', inject: ['codingSessions'], apply(context: Context) {
    context.effect(() => context.codingSessions.registerProvider(provider), 'fixture-sequential-source: registration')
  } }
  const fixtureLlm = { name: 'fixture-conversation', inject: ['llm'], apply(context: Context) {
    context.effect(() => context.llm.registerAdapter(['fixture'], new ConversationFixture()), 'fixture-conversation: response')
  } }
  const entries: [string, unknown][] = [['llm', Llm], ['session', Sessions], ['session-projection', Projection], ['system-prompt', Prompt],
    ['tools', Tools], ['agent', Agents], ['agent-loop', Loop], ['storage', Storage], ['storage-json', JsonStorage], ['storage-domain', Domain],
    ['session-persistence-jsonl', Jsonl], ['workspace', Workspace], ['typert-registry', Typert], ['skill-library', Library],
    ['coding-session', CodingSessions], ['fixture-sequential-source', nativePlugin], ['fixture-conversation', fixtureLlm]]
  const modules = new Map(entries.map(([name, value]): [string, unknown] => [`@deepseek-ai/dsh-${name}`, value]))
  const configs: Record<string, object> = { 'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' }, 'agent-loop': { agents: [] },
    'skill-library': { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), automaticMaintenanceIntervalMs: 0 },
    'coding-session': { enableClaudeDiscovery: false, enableSequentialHandoff: true } }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ name, config: configs[name.replace('@deepseek-ai/dsh-', '')] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Fixture Loader resolver absent')
  ctx.loader.internal = new Proxy(internal, { get(target, property, receiver): unknown {
    if (property === 'import') return async (specifier: string) => { if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`); return modules.get(specifier) }
    return Reflect.get(target, property, receiver)
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
  const project = await ctx.workspaceRegistry.create(projectPath)
  history = { ...history, cwd: project.path }
  const agent = await ctx.agentLoop.create(Sessions.SessionId('selected-y-root'), { provider: 'fixture', model: 'fixture' }, { cwd: project.path })
  agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier ordinary Y task.' }] })); await agent.whenIdle()
  const priorBoundary = agent.session.snapshotEvents().length
  await ctx.skillLibrary.approveLearningPolicy({ projectId: project.id, generatorId: 'native-observation', validatorId: 'native-observation-validator', operations: ['create', 'update'] })
  const imported = await ctx.codingSessions.importSession(source)
  let mirror = await ctx.codingSessions.claimSequential(imported.id, { source, project: project.path, expectedRevision: imported.revision,
    executionSessionId: agent.id, externalWritersClosed: true, nativeProfileUnchanged: true })
  const run = async () => { mirror = await ctx.codingSessions.continueSequential(mirror.id, 'Inspect the two current project files. Authorization: Bearer private-fixture-secret', mirror.revision); return mirror }
  return { ctx, root, project, agent, priorBoundary, run, setMode: (value: Mode) => { mode = value },
    count: () => count, lastRequest: () => lastRequest, entered, resume }
}

it('learns from a fresh sequential task and updates a managed procedure before creating another', async () => {
  const f = await fixture(); await f.run()
  const first = f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })
  expect(first).toHaveLength(1)
  expect(first[0]?.eventRefs.every(ref => Number(ref.split(':').at(-1)) >= f.priorBoundary)).toBe(true)
  expect(first[0]?.native).toMatchObject({ provider: 'codex', connectionId: 'fixture-native-profile', sessionId: 'original-native-session', turnId: 'current-native-turn-1' })
  expect(first[0]?.checks).toEqual([])
  expect(first[0]?.task).not.toMatch(/private-fixture-secret|Historical|Earlier/)
  const created = (await f.ctx.skillLibrary.list({ projectId: f.project.id })).items
  expect(created).toHaveLength(1); expect(created[0]?.ownership).toBe('y-managed')
  f.setMode('reversed-reads'); await f.run()
  const items = (await f.ctx.skillLibrary.list({ projectId: f.project.id })).items
  expect(items).toHaveLength(1); expect(items[0]?.id).toBe(created[0]?.id)
  const detail = await f.ctx.skillLibrary.detail({ id: items[0]!.id })
  expect(detail.content.match(/## Observed procedure/g)).toHaveLength(2)
  const tasks = f.agent.session.snapshotEvents().filter(event => event.type === 'skill/sequential-task-start')
  expect(tasks).toHaveLength(2); expect(tasks[0]?.data).not.toEqual(tasks[1]?.data)
  const retained = await readFile(join(f.root, 'storage', 'skill_learning.json'), 'utf8')
  expect(retained).toContain('current-native-turn-1'); expect(retained).toContain('current-native-turn-2')
  expect(retained).not.toContain('private-fixture-secret')
})

it.each(['unknown', 'duplicate', 'claude'] as const)('retains an explicit no-procedure outcome for %s without automatic learning', async (mode) => {
  const f = await fixture(mode)
  if (mode === 'duplicate') await expect(f.run()).rejects.toThrow(/duplicate|invalid|native/i)
  else await f.run()
  expect((await f.ctx.skillLibrary.list({ projectId: f.project.id })).items).toEqual([])
  expect(f.ctx.skillLibrary.listProposals({ projectId: f.project.id })).toEqual([])
  const endings = f.agent.session.snapshotEvents().filter(event => event.type === 'skill/sequential-task-end')
  expect(endings).toHaveLength(1)
  expect(f.ctx.skillLibrary.learningStatus({ projectId: f.project.id }).availability[0]?.state).toBe('unavailable')
})

it('settles a failed current task without inventing completed learning evidence', async () => {
  const f = await fixture('failure'); await expect(f.run()).rejects.toThrow('Fixture native persistence uncertain')
  expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toEqual([])
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'skill/sequential-task-end')).toHaveLength(1)
})

it('ties agent cancellation to the active sequential task without attributing it to the earlier turn', async () => {
  const f = await fixture('cancellation'); const pending = f.run(); await f.entered.promise
  f.agent.cancel({ kind: 'user' }); f.resume.resolve()
  await expect(pending).rejects.toThrow()
  expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toEqual([])
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'skill/sequential-task-end')).toHaveLength(1)
})

it('refuses native dispatch when the new sequential task admission cannot be flushed', async () => {
  const f = await fixture(); const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
  vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(session => session.snapshotEvents().some(event => event.type === 'skill/sequential-task-start')
    ? Promise.reject(new Error('Fixture task storage failed')) : flush(session))
  await expect(f.run()).rejects.toThrow(/storage|durab|flush/i)
  expect(f.count()).toBe(0); expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toEqual([])
})

it('learns supported current native patch facts through the actual sequential task and approved project policy', async () => {
  const f = await fixture('patches'); await f.run()
  const evidence = f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })
  expect(evidence).toHaveLength(1); expect(evidence[0]?.native?.actions.map(action => action.kind)).toEqual(['file-change', 'file-change'])
  expect(evidence[0]?.checks).toEqual([])
  const created = (await f.ctx.skillLibrary.list({ projectId: f.project.id })).items
  expect(created).toHaveLength(1)
  const detail = await f.ctx.skillLibrary.detail({ id: created[0]!.id })
  expect(detail.content).toContain('update `src/a.ts`'); expect(detail.content).toContain('update `src/b.ts`')
  expect(detail.content).not.toMatch(/Read `|Run `|Tests passed/)
  f.setMode('reversed-patches'); await f.run()
  expect((await f.ctx.skillLibrary.list({ projectId: f.project.id })).items.map(item => item.id)).toEqual([created[0]!.id])
})

it('rejects retained item callbacks after this exact sequential task has settled', async () => {
  const f = await fixture(); await f.run()
  const callback = f.lastRequest()?.onNativeItem
  expect(callback).toBeDefined()
  if (callback === undefined) return
  await expect(callback({ provider: 'codex', connectionId: brandString<SkillNativeConnectionId>('fixture-native-profile'), sessionId: brandString<SkillCodexSessionId>('original-native-session'),
    turnId: brandString<SkillCodexTurnId>('current-native-turn-1'), itemId: brandString<SkillCodexItemId>('late-item'), kind: 'read', name: 'native-read', phase: 'started', procedure: { kind: 'read', path: 'src/a.ts' } })).rejects.toThrow(/settled|live|current|task/i)
  expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toHaveLength(1)
})
it('aborts and joins an admitted sequential task before its learning service closes', async () => {
  const f = await fixture('cancellation'); const pending = f.run(); await f.entered.promise
  const entry = [...f.ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-skill-library')
  if (entry?.fiber === undefined) throw new Error('Fixture learning service fiber absent')
  let closed = false; const dispose = entry.fiber.dispose().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  f.resume.resolve(); await expect(pending).rejects.toThrow(); await dispose
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'skill/sequential-task-end')).toHaveLength(1)
})

const directSource: SkillSequentialTaskSource = { provider: 'codex', profileId: 'fixture-native-profile', nativeSessionId: 'original-native-session', toolMode: 'project-files' }
function readonlyController() {
  const recorded: SkillLearningObservation[] = []
  const controller = {
    registerLearningGenerator: () => () => {}, registerLearningValidator: () => () => {},
    setLearningAvailability: vi.fn(), proposeLearning: vi.fn(async () => {}), autoLearnEvidence: vi.fn(async () => {}),
    recordLearningEvidence: vi.fn(async (observation: SkillLearningObservation) => {
      recorded.push(structuredClone(observation))
      return { ...observation, id: brandString<SkillLearningEvidence['id']>(observation.sequentialTask!.taskId), createdAt: new Date().toISOString() }
    }),
  } satisfies SkillLearningRuntimeController
  return { controller, recorded }
}
const completeBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const placeholderTaskId = '00000000-0000-4000-8000-000000000000'

it('refuses a complete oversized task admission before Session append, flush or native dispatch even when its data fits', async () => {
  const f = await fixture(); const probe = readonlyController(); const text = 'Current task.'
  const data = { taskId: placeholderTaskId, source: directSource, task: text }
  const maximum = completeBytes(data) + 1
  expect(completeBytes({ type: 'skill/sequential-task-start', seq: f.priorBoundary, time: Date.now(), data, ignorable: true })).toBeGreaterThan(maximum)
  const bridge = new SequentialSkillLearning(f.ctx, probe.controller, {
    maxItems: 8, maxTaskBytes: 1600, maxInputBytes: maximum, timeoutMs: 1000,
  })
  onTestFinished(() => bridge.dispose())
  const before = f.agent.session.snapshotEvents().length; const flush = vi.spyOn(f.ctx.sessions, 'flush'); let dispatched = false
  await expect(bridge.run(f.agent, directSource, text, async (hooks) => {
    await hooks.beforeDispatch(); dispatched = true
  })).rejects.toThrow()
  expect(dispatched).toBe(false); expect(f.agent.session.snapshotEvents()).toHaveLength(before)
  expect(flush).not.toHaveBeenCalled(); expect(probe.controller.recordLearningEvidence).not.toHaveBeenCalled()
})

it('reserves complete task settlement and refuses an oversized native identity before appending it', async () => {
  const f = await fixture(); const probe = readonlyController(); const text = 'Current task.'; const nativeTurnId = '\u0000'.repeat(256)
  const start = { type: 'skill/sequential-task-start', seq: f.priorBoundary, time: Date.now(),
    data: { taskId: placeholderTaskId, source: directSource, task: text }, ignorable: true }
  const end = { type: 'skill/sequential-task-end', seq: f.priorBoundary + 2, time: Date.now(),
    data: { taskId: placeholderTaskId, nativeTurnId, outcome: 'completed', learning: 'unavailable' }, ignorable: true }
  const turnData = { taskId: placeholderTaskId, nativeTurnId }
  const maximum = completeBytes(start) + completeBytes(end) + completeBytes(turnData) + 3
  const bridge = new SequentialSkillLearning(f.ctx, probe.controller, {
    maxItems: 8, maxTaskBytes: 1600, maxInputBytes: maximum, timeoutMs: 1000,
  })
  onTestFinished(() => bridge.dispose())
  await expect(bridge.run(f.agent, directSource, text, async (hooks) => {
    await hooks.beforeDispatch(); await hooks.onNativeTurn(nativeTurnId)
  })).rejects.toThrow(/bound|budget|size/i)
  const events = f.agent.session.snapshotEvents().slice(f.priorBoundary).filter(event => event.type.startsWith('skill/sequential-'))
  expect(events.map(event => event.type)).toEqual(['skill/sequential-task-start', 'skill/sequential-task-end'])
  expect(events.reduce((bytes, event) => bytes + completeBytes(event) + 1, 0)).toBeLessThanOrEqual(maximum)
  expect(probe.controller.recordLearningEvidence).not.toHaveBeenCalled()
})

it('retains native completion but refuses complete oversized evidence before learning controller admission', async () => {
  const f = await fixture(); const probe = readonlyController()
  const calibration = await f.ctx.agentLoop.create(Sessions.SessionId('calibration-' + 'a'.repeat(240)), { provider: 'fixture', model: 'fixture' }, { cwd: f.project.path })
  const selected = await f.ctx.agentLoop.create(Sessions.SessionId('measurement-' + 'b'.repeat(240)), { provider: 'fixture', model: 'fixture' }, { cwd: f.project.path })
  const send = async (hooks: SkillSequentialTaskHooks) => {
    await hooks.beforeDispatch(); await hooks.onNativeTurn('current-native-turn-1')
    for (const [index, path] of ['src/a.ts', 'src/b.ts'].entries()) {
      const item = { provider: 'codex' as const, connectionId: brandString<SkillNativeConnectionId>(directSource.profileId),
        sessionId: brandString<SkillCodexSessionId>(directSource.nativeSessionId), turnId: brandString<SkillCodexTurnId>('current-native-turn-1'),
        itemId: brandString<SkillCodexItemId>(`item-${index}`), kind: 'read' as const, name: 'native-read', procedure: { kind: 'read' as const, path } }
      await hooks.onNativeItem({ ...item, phase: 'started' }); await hooks.onNativeItem({ ...item, phase: 'settled', outcome: 'reported-success' })
    }
    return { nativeTurnId: 'current-native-turn-1', nativeCompleted: true }
  }
  const broad = new SequentialSkillLearning(f.ctx, probe.controller, {
    maxItems: 8, maxTaskBytes: 1600, maxInputBytes: 64000, timeoutMs: 1000,
  })
  onTestFinished(() => broad.dispose())
  await broad.run(calibration, directSource, 'Current task.', send)
  const events = calibration.session.snapshotEvents().filter(event => event.type.startsWith('skill/sequential-'))
  const captureBytes = events.reduce((bytes, event) => bytes + completeBytes(event) + 1, 0)
  const observation = probe.recorded[0]!
  const evidenceBytes = completeBytes({ ...observation, id: placeholderTaskId, createdAt: new Date().toISOString() })
  const maximum = captureBytes + completeBytes('\u0000'.repeat(256)) + 64
  expect(evidenceBytes).toBeGreaterThan(maximum)
  probe.controller.recordLearningEvidence.mockClear(); probe.controller.setLearningAvailability.mockClear()
  const bounded = new SequentialSkillLearning(f.ctx, probe.controller, {
    maxItems: 8, maxTaskBytes: 1600, maxInputBytes: maximum, timeoutMs: 1000,
  })
  onTestFinished(() => bounded.dispose())
  await expect(bounded.run(selected, directSource, 'Current task.', send)).resolves.toEqual({ nativeTurnId: 'current-native-turn-1', nativeCompleted: true })
  expect(probe.controller.recordLearningEvidence).not.toHaveBeenCalled()
  const ending = selected.session.snapshotEvents().findLast(event => event.type === 'skill/sequential-task-end')
  expect(ending?.data).toMatchObject({ outcome: 'completed', learning: 'unavailable' })
  expect(probe.controller.setLearningAvailability).toHaveBeenLastCalledWith(f.project.id, expect.objectContaining({ state: 'unavailable' }))
})
