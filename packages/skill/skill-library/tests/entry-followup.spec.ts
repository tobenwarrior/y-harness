/** Service readiness, preregistered capabilities and real tool-result delivery retain their ownership. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import Session, { SessionId } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Workspace from '@deepseek-ai/dsh-workspace'
import Typert from '@deepseek-ai/dsh-typert-registry'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import Projection from '@deepseek-ai/dsh-session-projection'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Skills from '@deepseek-ai/dsh-skill'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { skillLearningDomain } from '../src/learning-record.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import SkillLibraryController, { type Config } from '../src/index.ts'
import { SkillLibrary } from '../src/library.ts'

async function fixture(beforeInit: (controller: SkillLibraryController, agent: Agent) => void = () => undefined, volatileRegistry = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-entry-followup-')); const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Storage)
  if (volatileRegistry) await ctx.plugin({ name: 'fixture-memory-backend', inject: ['storage'], apply(context: Context) {
    const backend = new MemoryStorageBackend()
    context.effect(() => {
      const unregister = context.storage.backend.register('memory', backend)
      return async () => { unregister(); await backend.close() }
    })
    context.provide(storageBackendServiceKey('memory'), backend)
  } })
  else await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(Domain, { backend: volatileRegistry ? 'memory' : 'json' }); await ctx.plugin(Session)
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(Workspace); await ctx.plugin(Typert); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
  await ctx.plugin(Llm); await ctx.plugin(Projection); await ctx.plugin(Agents); await ctx.plugin(Loop, { agents: [] })
  const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  await ctx.workspaceRegistry.create(project)
  const agent = await ctx.agentLoop.create(SessionId('fixture-selected-root'), {}, { cwd: project })
  class RegisteredController extends SkillLibraryController {
    constructor(context: Context, config: Config) { super(context, config); beforeInit(this, agent) }
  }
  const fiber = await ctx.plugin(RegisteredController, { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'),
    bundledSkillDir: join(root, 'bundled'), automaticMaintenanceIntervalMs: 0 })
  const directory = join(project, '.dsh', 'skills', 'release')
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, '---\nname: release\ndescription: Release instructions\n---\n\nKeep the reviewed instructions.\n')
  return { root, ctx, fiber, path, agent, controller: ctx.skillLibrary }
}

it('refuses public operations before initialization and carries preregistered capabilities through real initialization and disposal', async () => {
  const native = { name: 'fixture-native', list: async () => ({ status: { provider: 'fixture-native', state: 'connected' as const }, entries: [] }) }
  const generator = { id: 'fixture-generator', generate: async () => ({ drafts: [], uncertainty: [] }) }
  const validator = { id: 'fixture-validator', trusted: false, validate: async () => ({ constraintsPreserved: false,
    resourcesPreserved: false, referenceImpactChecked: false, survivorEquivalent: false, findings: ['Fixture denial.'] }) }
  const f = await fixture((controller, agent) => {
    expect(() => controller.list({})).toThrow('skill library is not initialized')
    expect(() => controller.decisionStatus()).toThrow('skill decision is not initialized')
    expect(() => controller.learningStatus({})).toThrow('skill learning is not initialized')
    expect(() => controller.runSequentialTask(agent, { provider: 'codex',
      profileId: 'fixture', nativeSessionId: 'fixture', toolMode: 'project-files' }, 'Current task.', async () => undefined))
      .toThrow('Sequential task learning is not ready.')
    controller.registerNativeProvider(native); controller.registerLearningGenerator(generator)
    controller.registerLearningValidator(validator)
    expect(() => controller.registerNativeProvider(native)).toThrow('duplicate')
    expect(() => controller.registerLearningGenerator(generator)).toThrow('duplicate learning generator')
    expect(() => controller.registerLearningValidator(validator)).toThrow('duplicate learning validator')
  })
  expect((await f.controller.list({})).providers).toContainEqual({ provider: 'fixture-native', state: 'connected' })
  expect(f.controller.learningStatus({}).generators).toContain('fixture-generator')
  expect(f.controller.learningStatus({}).validators).toContainEqual({ id: 'fixture-validator', trusted: false })
  await f.fiber.dispose(); expect(f.ctx.get('skillLibrary')).toBeUndefined()
  expect(await readFile(f.path, 'utf8')).toContain('Keep the reviewed instructions.')
})

it('observes only real successful skill results and reports asynchronous observation publication failures', async () => {
  const f = await fixture(); const value = { name: 'release', provider: 'filesystem', content: 'Keep the reviewed instructions.',
    resourceBase: { kind: 'directory', path: dirname(f.path) } }
  let fail = false
  const definition = defineTool({ name: 'skill', description: 'Fixture skill instructions', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, provider: { type: 'string' },
      content: { type: 'string' }, resourceBase: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string' }, path: { type: 'string' } } } } },
    render: () => [{ type: 'text', text: 'Fixture instructions.' }] },
    async execute() { if (fail) throw new Error('fixture tool failed'); return value } })
  f.ctx.tools.register(definition); f.ctx.tools.register({ ...definition, name: 'other' })
  const observer = vi.spyOn(SkillLibrary.prototype, 'observeToolResult')
  const warnings = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => undefined)
  onTestFinished(() => { observer.mockRestore(); warnings.mockRestore() })
  const execute = (name: string) => f.ctx.tools.execute({ callId: ToolCallId(`fixture-${name}`), name, arguments: {}, signal: new AbortController().signal })
  await execute('other'); fail = true; expect((await execute('skill')).isError).toBe(true)
  expect(observer).not.toHaveBeenCalled()
  fail = false; expect((await execute('skill')).isError).toBe(false)
  await vi.waitFor(async () => { expect((await f.controller.list({})).items[0]?.usage.loadCount).toBe(1) })
  observer.mockRejectedValueOnce(new Error('fixture durable observation unavailable'))
  await execute('skill')
  await vi.waitFor(() => { expect(warnings).toHaveBeenCalledWith('skill-library: load observation skipped: Error: fixture durable observation unavailable') })
  expect((await f.controller.list({})).items[0]?.usage.loadCount).toBe(1)
  expect(await readFile(f.path, 'utf8')).toContain('Keep the reviewed instructions.')
})

it('routes retained revision rollback through the service without replacing instruction membership', async () => {
  const f = await fixture(); const original = await readFile(f.path, 'utf8')
  await writeFile(f.path, original.replace('Keep the reviewed instructions.', 'Keep instructions.\n\n\n\nFinish.'))
  const item = (await f.controller.list({})).items[0]!
  await f.controller.adopt({ id: item.id, expectedHash: item.contentHash })
  const preview = await f.controller.previewCleanup({ ids: [item.id] }); await f.controller.applyCleanup({ proposalId: preview.id })
  const detail = await f.controller.detail({ id: item.id })
  await f.controller.rollback({ id: item.id, expectedHash: detail.item.contentHash, revisionId: detail.revisions[0]!.id })
  expect((await f.controller.detail({ id: item.id })).revisions).toHaveLength(2)
  expect(await readFile(f.path, 'utf8')).toBe(preview.changes[0]!.before)
})

it('observes actual live registry views both with and without a workspace selector', async () => {
  const f = await fixture(); await f.ctx.plugin(Skills)
  f.ctx.skills.register({ name: 'runtime-release', description: 'Runtime release workflow', source: 'runtime', content: 'Selected runtime instructions.' })
  const withoutProject = await f.ctx.agentLoop.create(SessionId('fixture-global-root'), {})
  const inventory = await f.controller.list({})
  expect(inventory.providers).toContainEqual({ provider: 'registry:fixture-selected-root', state: 'connected' })
  expect(inventory.providers).toContainEqual({ provider: 'registry:fixture-global-root', state: 'connected' })
  const selected = inventory.items.filter(value => value.name === 'runtime-release')
  expect(selected).toHaveLength(3)
  const item = selected.find(value => value.path.includes('fixture-selected-root'))!
  expect(item.projectIds).toEqual([f.ctx.workspaceRegistry.list()[0]!.id])
  expect(selected.find(value => value.path.includes('/global/'))?.projectIds).toEqual([])
  expect((await f.controller.detail({ id: item.id })).content).toBe('Selected runtime instructions.')
  expect(withoutProject.session.header.cwd).toBeUndefined()
})

it('revokes a persisted enabled semantic consent before restoring its archived source', async () => {
  const f = await fixture(); const original = await readFile(f.path, 'utf8')
  const item = (await f.controller.list({})).items[0]!
  await f.controller.adopt({ id: item.id, expectedHash: item.contentHash })
  const policy = await f.controller.approveLearningPolicy({ operations: ['compress', 'archive'], validatorId: 'instruction-redundancy-validator' })
  await f.controller.setAutomaticLearning({ id: item.id, expectedHash: item.contentHash, policyId: policy.id, enabled: true })
  await f.controller.archive({ id: item.id, expectedHash: item.contentHash })
  // A separate durable storage owner publishes an otherwise valid retained row.
  const domain = f.ctx.storageDomain.get(skillLearningDomain.name)
  if (domain === undefined) throw new Error('Fixture learning domain is not open.')
  const consent = domain.table('opt_ins')
  const prior = f.controller.learningStatus({}).optIns.find(value => value.id === item.id)!
  await consent.put(item.id, { ...prior, enabled: true })
  await f.controller.restore({ id: item.id })
  expect(consent.get(item.id)).toMatchObject({ enabled: false })
  expect(await readFile(f.path, 'utf8')).toBe(original)
})

it('archives and restores an unopted source without inventing semantic consent', async () => {
  const f = await fixture(); const before = await readFile(f.path, 'utf8')
  const item = (await f.controller.list({})).items[0]!
  expect(f.controller.learningStatus({}).optIns).toEqual([])
  await f.controller.archive({ id: item.id, expectedHash: item.contentHash })
  expect((await f.controller.detail({ id: item.id })).item.status).toBe('archived')
  expect(f.controller.learningStatus({}).optIns).toEqual([])
  await f.controller.restore({ id: item.id })
  expect(await readFile(f.path, 'utf8')).toBe(before)
  expect(f.controller.learningStatus({}).optIns).toEqual([])
})

it('retains the complete metadata inventory when read-only provider observation exceeds its project cache bound', async () => {
  const f = await fixture(undefined, true)
  for (let index = 0; index < 128; index++) {
    const project = join(f.root, `observed-project-${index}`)
    await mkdir(join(project, '.git'), { recursive: true }); await f.ctx.workspaceRegistry.create(project)
  }
  const first = await f.controller.list({}); const second = await f.controller.list({})
  expect(first.projects).toHaveLength(129); expect(second.projects).toEqual(first.projects)
  expect(first.items.map(item => item.name)).toEqual(['release'])
  expect(second.items).toEqual(first.items)
  expect(await readFile(f.path, 'utf8')).toContain('Keep the reviewed instructions.')
})
