/** Real idle Agent ownership and Session durability remain independent of learning publication. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Workspace from '@deepseek-ai/dsh-workspace'
import Llm from '@deepseek-ai/dsh-llm'
import Projection from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SequentialSkillLearning } from '../src/sequential-learning.ts'
import type { SkillLearningRuntimeController } from '../src/learning-runtime.ts'
import type { SkillLearningEvidence, SkillLearningNativeItem, SkillLearningObservation, SkillSequentialTaskHooks, SkillSequentialTaskSource } from '../src/learning-types.ts'

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}
async function fixture(timeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sequential-followup-')); const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root: join(root, 'storage') }); await ctx.plugin(Domain, { backend: 'json' })
  const sessionFiber = await ctx.plugin(Sessions)
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(Workspace); await ctx.plugin(Llm); await ctx.plugin(Projection); await ctx.plugin(Prompt)
  await ctx.plugin(Tools); await ctx.plugin(Agents); await ctx.plugin(Loop, { agents: [] })
  const projectPath = join(root, 'project'); await mkdir(join(projectPath, '.git'), { recursive: true })
  const project = await ctx.workspaceRegistry.create(projectPath)
  const agent = await ctx.agentLoop.create(SessionId('fixture-root'), {}, { cwd: project.path })
  const observations: SkillLearningObservation[] = []
  const controller = {
    registerLearningGenerator: () => () => undefined,
    setLearningAvailability: vi.fn(), proposeLearning: vi.fn(async () => undefined),
    recordLearningEvidence: vi.fn(async (observation: SkillLearningObservation): Promise<SkillLearningEvidence> => {
      observations.push(structuredClone(observation))
      return { ...observation, id: brandString<SkillLearningEvidence['id']>('fixture-evidence'), createdAt: new Date().toISOString() }
    }),
  } satisfies SkillLearningRuntimeController
  const bridge = new SequentialSkillLearning(ctx, controller, { maxItems: 8, maxTaskBytes: 1600, maxInputBytes: 64000, timeoutMs })
  onTestFinished(() => bridge.dispose())
  return { ctx, agent, project, controller, bridge, observations, sessionFiber }
}
const source: SkillSequentialTaskSource = { provider: 'codex', profileId: 'fixture-connection', nativeSessionId: 'fixture-native', toolMode: 'project-files' }
async function pairedReads(hooks: SkillSequentialTaskHooks, outcome: 'reported-success' | 'unknown' = 'reported-success', skillReadPath?: string) {
  await hooks.beforeDispatch(); await hooks.onNativeTurn('fixture-current-turn')
  for (const [index, path] of ['src/first.ts', 'src/second.ts'].entries()) {
    const item: SkillLearningNativeItem = { provider: 'codex', connectionId: brandString<SkillLearningNativeItem['connectionId']>(source.profileId),
      sessionId: brandString<Extract<SkillLearningNativeItem, { provider: 'codex' }>['sessionId']>(source.nativeSessionId), turnId: brandString<Extract<SkillLearningNativeItem, { provider: 'codex' }>['turnId']>('fixture-current-turn'),
      itemId: brandString<SkillLearningNativeItem['itemId']>(`fixture-item-${index}`), kind: 'read', name: 'read', phase: 'started', procedure: { kind: 'read', path },
      ...skillReadPath === undefined ? {} : { skillReadPath } }
    await hooks.onNativeItem(item); await hooks.onNativeItem({ ...item, phase: 'settled', ...outcome === 'unknown' ? {} : { outcome } })
  }
  return { nativeCompleted: true }
}

it('uses proposal-only learning when the optional automatic policy owner is absent', async () => {
  const f = await fixture()
  await expect(f.bridge.run(f.agent, source, 'Inspect current project files.', pairedReads)).resolves.toEqual({ nativeCompleted: true })
  expect(f.controller.proposeLearning).toHaveBeenCalledExactlyOnceWith({ projectId: f.project.id, operation: 'learn', evidenceIds: ['fixture-evidence'], generatorId: 'native-observation' })
  expect(f.observations).toHaveLength(1)
  expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'skill/sequential-task-end')?.data).toMatchObject({ outcome: 'completed', learning: 'eligible' })
})
it.each(['task', 'session'] as const)('does not learn from valid returned evidence belonging to a different %s', async (mismatch) => {
  const f = await fixture(); const record = f.controller.recordLearningEvidence.getMockImplementation()!
  f.controller.recordLearningEvidence.mockImplementation(async (observation) => {
    const evidence = await record(observation)
    return mismatch === 'session' ? { ...evidence, sessionId: 'different-live-session' }
      : { ...evidence, sequentialTask: { ...observation.sequentialTask!, taskId: brandString<NonNullable<SkillLearningEvidence['sequentialTask']>['taskId']>('different-admitted-task') } }
  })
  await expect(f.bridge.run(f.agent, source, 'Inspect current project files.', pairedReads)).resolves.toEqual({ nativeCompleted: true })
  expect(f.controller.proposeLearning).not.toHaveBeenCalled()
  expect(f.controller.setLearningAvailability).toHaveBeenLastCalledWith(f.project.id, expect.objectContaining({ state: 'unavailable' }))
  expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'skill/sequential-task-end')?.data).toMatchObject({ outcome: 'completed', learning: 'eligible' })
})
it('retains native settlement when proposal publication fails', async () => {
  const f = await fixture(); f.controller.proposeLearning.mockRejectedValueOnce(new Error('fixture proposal publication unavailable'))
  await expect(f.bridge.run(f.agent, source, 'Inspect current project files.', pairedReads)).resolves.toEqual({ nativeCompleted: true })
  expect(f.controller.proposeLearning).toHaveBeenCalledOnce()
  expect(f.controller.setLearningAvailability).toHaveBeenLastCalledWith(f.project.id, expect.objectContaining({ state: 'unavailable' }))
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'skill/sequential-task-end')).toHaveLength(1)
})
it('retains paired skill-read metadata with unknown outcomes without claiming successful procedure learning', async () => {
  const f = await fixture()
  await f.bridge.run(f.agent, source, 'Inspect current project files.', hooks => pairedReads(hooks, 'unknown', 'skills/release/SKILL.md'))
  expect(f.controller.recordLearningEvidence).not.toHaveBeenCalled(); expect(f.controller.proposeLearning).not.toHaveBeenCalled()
  const items = f.agent.session.snapshotEvents().filter(event => event.type === 'skill/sequential-native-item')
  expect(items).toHaveLength(4); expect(items.every(event => event.data.item.skillReadPath === 'skills/release/SKILL.md')).toBe(true)
  expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'skill/sequential-task-end')?.data).toMatchObject({ outcome: 'completed', learning: 'insufficient' })
})
it('refuses dispatch when the Session durability boundary reports no participating listener', async () => {
  const f = await fixture(); let dispatched = false
  const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValue(false)
  onTestFinished(() => { checkpoint.mockRestore() })
  const pending = f.bridge.run(f.agent, source, 'Inspect current project files.', async (hooks) => { await hooks.beforeDispatch(); dispatched = true })
  await expect(pending).rejects.toThrow('Sequential task failed and its durable settlement is unavailable.')
  expect(dispatched).toBe(false); expect(f.controller.recordLearningEvidence).not.toHaveBeenCalled()
  expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'skill/sequential-task-end')?.data).toMatchObject({ outcome: 'failed', learning: 'unavailable' })
})
it('joins timed-out underlying durability before disposing and never dispatches during that uncertainty', async () => {
  const f = await fixture(20); const entered = deferred(); const release = deferred(); let dispatched = false
  f.ctx.on('session/flush', () => { entered.resolve(); return release.promise })
  vi.useFakeTimers(); onTestFinished(() => { release.resolve(); vi.useRealTimers() })
  const pending = f.bridge.run(f.agent, source, 'Inspect current project files.', async (hooks) => { await hooks.beforeDispatch(); dispatched = true })
  void pending.catch(() => undefined)
  await entered.promise; await vi.advanceTimersByTimeAsync(20); await vi.advanceTimersByTimeAsync(20)
  await expect(pending).rejects.toThrow('Sequential task failed and its durable settlement is unavailable.')
  let disposed = false; const disposal = f.bridge.dispose().then(() => { disposed = true })
  await Promise.resolve(); await Promise.resolve(); expect(disposed).toBe(false)
  expect(dispatched).toBe(false); expect(f.controller.recordLearningEvidence).not.toHaveBeenCalled()
  release.resolve(); await disposal; expect(disposed).toBe(true); vi.useRealTimers()
})

it('refuses dispatch if public Session event observation begins unloading its live durability service', async () => {
  const f = await fixture(); let dispatched = false; let removal: Promise<void> | undefined
  f.ctx.on('session/event', (_session, event) => {
    if (event.type === 'skill/sequential-task-start') { removal = f.sessionFiber.dispose(); void removal.catch(() => undefined) }
  })
  const pending = f.bridge.run(f.agent, source, 'Inspect current project files.', async (hooks) => {
    await hooks.beforeDispatch(); dispatched = true
  })
  await expect(pending).rejects.toThrow('Sequential task failed and its durable settlement is unavailable.')
  const failure: unknown = await pending.catch((error: unknown) => error)
  if (!(failure instanceof AggregateError)) throw new Error('Fixture expected the actual durability refusal aggregate.')
  expect(failure.errors.map((error: unknown) => error instanceof Error ? error.message : String(error)))
    .toContain('Sequential task durability is unavailable.')
  await removal
  expect(dispatched).toBe(false); expect(f.controller.recordLearningEvidence).not.toHaveBeenCalled()
})
