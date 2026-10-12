/** Native notifications pass through the actual Loader, agent loop and durable project policy. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Sessions from '@deepseek-ai/dsh-session'
import * as Projection from '@deepseek-ai/dsh-session-projection'
import * as Prompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Loop from '@deepseek-ai/dsh-agent-loop'
import * as Sandbox from '@deepseek-ai/dsh-sandbox-policy'
import * as Approval from '@deepseek-ai/dsh-user-approval'
import * as Questions from '@deepseek-ai/dsh-user-questions'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import * as Library from '../src/index.ts'
import { CodexBackendConnection } from '../../../llm/llm-pi-ai/src/codex-backend-connection.ts'
import type { CodexPeer } from '../../../llm/llm-pi-ai/src/codex-backend.ts'

const native = vi.hoisted(() => ({ peer: undefined as CodexPeer | undefined }))
vi.mock('../../../llm/llm-pi-ai/src/codex-backend-process.ts', () => ({
  startCodexProcess: () => {
    if (native.peer === undefined) throw new Error('native fixture peer was not configured')
    return native.peer
  },
}))

it('automatically creates only a newly managed project procedure and updates it before creating another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-learning-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const projectPath = join(root, 'project'); await mkdir(join(projectPath, '.git'), { recursive: true })
  const nativeHome = join(root, 'native-home'); await mkdir(nativeHome)
  await writeFile(join(nativeHome, 'harness-backend.json'), JSON.stringify({ enabled: true, tiers: {}, models: [{ id: 'fixture-model', name: 'Fixture native', description: '', efforts: [{ id: 'low', description: '' }], defaultEffort: 'low', serviceTiers: [], inputModalities: ['text'] }] }))
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {
    DSH_CODEX_BINARY: join(root, 'fixture-codex'), DSH_CODEX_HOME: nativeHome,
    DSH_CODEX_SHELL_HOME: join(root, 'shell-home'), DSH_CODEX_CWD: projectPath, DSH_CODEX_NODE: process.execPath,
  } }]))
  const moduleEntries: [string, unknown][] = [
    ['llm', Llm], ['session', Sessions], ['session-projection', Projection], ['system-prompt', Prompt],
    ['tools', Tools], ['agent', Agents], ['agent-loop', Loop], ['sandbox-policy', Sandbox], ['user-approval', Approval],
    ['user-questions', Questions], ['storage', Storage], ['storage-json', JsonStorage], ['storage-domain', Domain],
    ['session-persistence-jsonl', Jsonl], ['workspace', Workspace], ['typert-registry', Typert], ['skill-library', Library],
    ['fixture-codex-connection', { default: CodexBackendConnection }],
  ]
  const modules = new Map<string, unknown>(moduleEntries.map(([name, module]): [string, unknown] => [
    `@deepseek-ai/dsh-${name}`, module,
  ]))
  const configs: Record<string, object> = {
    'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' },
    'sandbox-policy': { mode: 'workspace-write' }, 'user-approval': { policy: 'ask' }, 'agent-loop': { agents: [] },
    'skill-library': { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), automaticMaintenanceIntervalMs: 0 },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ name, config: configs[name.replace('@deepseek-ai/dsh-', '')] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected native fixture module ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('unexpected registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job') },
    resolveSync(): never { throw new Error('unexpected resolution') },
    load(): never { throw new Error('unexpected load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
  const project = await ctx.workspaceRegistry.create(projectPath)
  await ctx.codexBackendConnection.getState()
  await ctx.skillLibrary.approveLearningPolicy({ validatorId: 'native-observation-validator', generatorId: 'native-observation', projectId: project.id, operations: ['create', 'update'] })
  let count = 0
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const emit = (method: string, params: Record<string, unknown>) => { for (const listener of listeners) listener(method, params) }
  native.peer = {
    notify() {}, close() { listeners.clear() },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async request(method) {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'native-thread' } }
      if (method !== 'turn/start') return {}
      const turnId = `native-turn-${++count}`
      queueMicrotask(() => {
        const sequence = count === 1 ? ['read', 'command'] : ['command', 'read']
        for (const [index, kind] of sequence.entries()) {
          const item = { id: `${turnId}-${index}`, type: 'commandExecution', source: 'agent', command: kind === 'read' ? "/bin/zsh -lc 'cat src/source.ts'" : "/bin/zsh -lc 'pnpm run test'", cwd: project.path,
            commandActions: kind === 'read' ? [{ type: 'read', command: 'cat src/source.ts', name: 'source.ts', path: join(project.path, 'src/source.ts') }] : [{ type: 'unknown', command: 'pnpm run test' }], status: 'completed', exitCode: 0, aggregatedOutput: 'sensitive stdout must stay out of evidence' }
          emit('item/started', { threadId: 'native-thread', turnId, item })
          emit('item/completed', { threadId: 'native-thread', turnId, item })
        }
        emit('turn/completed', { threadId: 'native-thread', turn: { id: turnId, status: 'completed' } })
      })
      return { turn: { id: turnId } }
    },
  }
  onTestFinished(() => { native.peer = undefined })
  const agent = await ctx.agentLoop.create(Sessions.SessionId('native-live-session'), { provider: 'codex-backend', model: 'fixture-model' }, { cwd: project.path })
  const run = async () => {
    const expected = count + 1
    agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect project files and run the appropriate checks.' }] }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toEqual([])
    await vi.waitFor(() => { expect(count).toBe(expected); expect(ctx.skillLibrary.listProposals({ projectId: project.id }).filter(row => row.state === 'applied')).toHaveLength(expected) })
  }
  await run()
  const created = (await ctx.skillLibrary.list({ projectId: project.id })).items[0]!
  expect(created).toMatchObject({ ownership: 'y-managed', scope: 'project', pinned: false })
  await run()
  const inventory = await ctx.skillLibrary.list({ projectId: project.id })
  expect(inventory.items).toHaveLength(1); expect(inventory.items[0]?.id).toBe(created.id)
  const detail = await ctx.skillLibrary.detail({ id: created.id })
  expect(detail.content.match(/## Observed procedure/g)).toHaveLength(2)
  expect(detail.revisions[0]?.reason).toBe('learning')
  const retained = await readFile(join(root, 'storage', 'skill_learning.json'), 'utf8')
  expect(retained).toContain('native-turn-1'); expect(retained).toContain('native-turn-2')
  expect(retained).not.toMatch(/sensitive input|sensitive stdout/)
  expect(ctx.skillLibrary.listLearningEvidence({ projectId: project.id }).every(row => row.checks.length === 0)).toBe(true)
  expect(ctx.skillLibrary.listLearningEvidence({ projectId: project.id }).every(row => row.native?.connectionId.length === 64)).toBe(true)
  const nativeEvents = agent.session.snapshotEvents().filter(event => event.type === 'skill/native-item')
  expect(nativeEvents).toHaveLength(8)
  expect(nativeEvents.every(event => event.ignorable === true)).toBe(true)
})
