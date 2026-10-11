/** Native process boundary is synthetic; registrations, sessions and project policy are real. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Sandbox from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Workspace from '@deepseek-ai/dsh-workspace'
import Typert from '@deepseek-ai/dsh-typert-registry'
import SkillLibrary from '@deepseek-ai/dsh-skill-library'
import CodingSessions from '@deepseek-ai/dsh-coding-session'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { CodexBackendConnection } from '../src/codex-backend-connection.ts'
import type { CodexPeer } from '../src/codex-backend.ts'

const native = vi.hoisted(() => ({ start: vi.fn<typeof import('../src/codex-backend-process.ts').startCodexProcess>() }))
vi.mock('../src/codex-backend-process.ts', async original => ({
  ...await original<typeof import('../src/codex-backend-process.ts')>(), startCodexProcess: native.start,
}))
afterEach(() => { native.start.mockReset() })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-connected-services-')); const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const cwd = join(dir, 'project'); await mkdir(cwd)
  // Own project discovery even when the runner's temporary directory is inside another repository.
  await mkdir(join(cwd, '.git'))
  await writeFile(join(dir, 'harness-backend.json'), JSON.stringify({ enabled: true, tiers: {}, models: [{
    id: 'fixture-model', name: 'Fixture', description: '', efforts: [{ id: 'low', description: 'Low' }], defaultEffort: 'low',
    inputModalities: ['text'], serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
  }] }))
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {
    DSH_CODEX_BINARY: join(dir, 'never-executed.js'), DSH_CODEX_HOME: dir, DSH_CODEX_CWD: cwd,
    DSH_CODEX_SHELL_HOME: join(dir, 'shell'), DSH_CODEX_NODE: process.execPath,
  } }]))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Sandbox, { mode: 'read-only', workspaceRoot: cwd }); await ctx.plugin(Approval, { policy: 'never' })
  await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root: join(dir, 'storage') }); await ctx.plugin(Domain, { backend: 'json' })
  await ctx.plugin(Jsonl, { root: join(dir, 'sessions'), compression: 'none' })
  await ctx.plugin(Workspace); await ctx.plugin(Typert)
  const project = await ctx.workspaceRegistry.create(cwd)
  await ctx.plugin(SkillLibrary, { dshHome: join(dir, 'skills-home'), agentsHome: join(dir, 'agents-home'),
    bundledSkillDir: join(dir, 'bundled'), automaticMaintenanceIntervalMs: 0 })
  await ctx.plugin(CodingSessions, { ...CodingSessions.Config(), enableClaudeDiscovery: false })
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const calls: string[] = []
  const peer: CodexPeer = { request: async (method) => {
    calls.push(method)
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'model/list') return { data: [{ model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
      defaultReasoningEffort: 'low', inputModalities: ['text'], serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] }] }
    if (method === 'skills/list') return { data: [{ cwd: project.path, skills: [], errors: [] }] }
    if (method === 'thread/list') return { data: [], nextCursor: null }
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        const item = { id: 'fixture-item', type: 'webSearch', status: 'completed', result: 'private native body' }
        for (const callback of listeners) {
          callback('item/started', { threadId: 'fixture-thread', turnId: 'fixture-turn', item })
          callback('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item })
          callback('turn/completed', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } })
        }
      })
      return { turn: { id: 'fixture-turn' } }
    }
    return {}
  }, notify() {}, subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
  close: () => { for (const callback of listeners) callback('__closed', {}); listeners.clear() } }
  native.start.mockReturnValue(peer)
  const connection = await ctx.plugin(CodexBackendConnection); await connection.await()
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, project, connection, calls, harness }
}

describe('Codex backend optional service wiring', () => {
  it('registers disconnected inventories without native startup and withdraws them with the connection owner', async () => {
    const f = await fixture()
    expect((await f.ctx.codingSessions.getState()).sources).toMatchObject([{ provider: 'codex', connected: false }])
    const skillPath = join(f.project.path, '.dsh', 'skills', 'fixture-existing', 'SKILL.md')
    await mkdir(join(f.project.path, '.dsh', 'skills', 'fixture-existing'), { recursive: true })
    await writeFile(skillPath, '---\nname: fixture-existing\ndescription: Existing unrelated fixture\n---\nKeep this instruction.\n')
    const disconnected = await f.ctx.skillLibrary.list({ projectId: f.project.id })
    expect(disconnected.items.filter(item => item.provider === 'codex-backend')).toEqual([])
    expect(disconnected.items.some(item => item.path === skillPath && item.provider !== 'codex-backend')).toBe(true)
    expect(disconnected.providers.find(provider => provider.provider === 'codex-backend')).toMatchObject({ state: 'disconnected' })
    const unrelatedIds = disconnected.items.filter(item => item.provider !== 'codex-backend').map(item => item.id).sort()
    expect(native.start).not.toHaveBeenCalled()
    await f.ctx.codexBackendConnection.refresh()
    const source = (await f.ctx.codingSessions.getState()).sources[0]
    if (source === undefined) throw new Error('Fixture Codex source was not registered')
    expect(source.connected).toBe(true)
    expect((await f.ctx.codingSessions.discover(source)).items).toEqual([])
    const connected = await f.ctx.skillLibrary.list({ projectId: f.project.id })
    expect(connected.items.filter(item => item.provider === 'codex-backend')).toEqual([])
    expect(connected.providers.find(provider => provider.provider === 'codex-backend')).toMatchObject({ state: 'connected' })
    expect(connected.items.filter(item => item.provider !== 'codex-backend').map(item => item.id).sort()).toEqual(unrelatedIds)
    expect(f.calls).toContain('thread/list'); expect(f.calls).toContain('skills/list')
    const nativeSkillReads = f.calls.filter(method => method === 'skills/list').length
    await f.connection.dispose()
    expect((await f.ctx.codingSessions.getState()).sources).toEqual([])
    const withdrawn = await f.ctx.skillLibrary.list({ projectId: f.project.id })
    expect(withdrawn.providers.some(provider => provider.provider === 'codex-backend')).toBe(false)
    expect(withdrawn.items.filter(item => item.provider !== 'codex-backend').map(item => item.id).sort()).toEqual(unrelatedIds)
    expect(f.calls.filter(method => method === 'skills/list')).toHaveLength(nativeSkillReads)
  })

  it.each([false, true])('logs sanitized native metadata only into the exact selected live session (sessionId supplied=%s)', async (selected) => {
    const f = await fixture(); await f.ctx.codexBackendConnection.refresh()
    const agent = await f.harness.create(SessionId('fixture-selected-native'), {}, { cwd: f.project.path })
    await f.ctx.agents.withInitiator(agent, async () => {
      const chunks = []
      for await (const chunk of f.ctx.llm.stream({ provider: 'codex-backend', model: 'fixture-model', messages: [],
        ...(selected ? { sessionId: agent.session.id } : {}) })) chunks.push(chunk)
      const finish = chunks.at(-1)
      expect(finish?.type === 'finish' ? finish.reason : finish).toEqual({ kind: 'stop' })
    })
    const observations = agent.session.snapshotEvents().filter(event => event.type === 'skill/native-item')
    expect(observations).toHaveLength(selected ? 2 : 0)
    expect(JSON.stringify(observations)).not.toContain('private native body')
    expect(f.calls).toContain('turn/start')
  })
})
