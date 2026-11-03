/** The Bot roster and native Codex dynamic actions share one live Context. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@yharness/cordis'
import { createUserMessage } from '@yharness/llm'
import type { Agent } from '@yharness/agent'
import { SessionId } from '@yharness/session'
import { renderPrompt } from '@yharness/system-prompt'
import { scopeOf } from '@yharness/scope'
import { expect, it, onTestFinished, vi } from 'vitest'
import Loader, { type ModuleLoaderV2 } from '@yharness/cordis-plugin-loader'
import Include from '@yharness/cordis-plugin-include'
import * as Llm from '@yharness/llm'
import * as Sessions from '@yharness/session'
import * as Projection from '@yharness/session-projection'
import * as Prompt from '@yharness/system-prompt'
import * as Tools from '@yharness/tools'
import * as Agents from '@yharness/agent'
import * as Loop from '@yharness/agent-loop'
import * as Sandbox from '@yharness/sandbox-policy'
import * as ApprovalModule from '@yharness/user-approval'
import * as Questions from '@yharness/user-questions'
import * as StorageModule from '@yharness/storage'
import * as Typert from '@yharness/typert-registry'
import AgentPresets from '../../../preset/agent-preset-registry/src/index.ts'
import * as ToolSchedule from '../../../schedule/tool-schedule/src/index.ts'
import { DomainFacility } from '@yharness/storage-domain'
import type { StorageBackend } from '@yharness/storage'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import BotService from '../src/index.ts'
import type { BotNativeToolProvider } from '../src/native-tools.ts'
import { BotId } from '../src/types.ts'
import { CodexBackendConnection } from '../../../llm/llm-pi-ai/src/codex-backend-connection.ts'
import type { CodexPeer } from '../../../llm/llm-pi-ai/src/codex-backend.ts'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@yharness/launch-environment'
import { pathToFileURL } from 'node:url'
import type {} from '@yharness/agent-loop'

const native = vi.hoisted(() => ({
  peer: undefined as CodexPeer | undefined,
  handleRequest: undefined as ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined,
}))

vi.mock('../../../llm/llm-pi-ai/src/codex-backend-process.ts', () => ({
  prepareCodexHomeDirectories: vi.fn(async () => {}),
  startCodexProcess: (_options: unknown, handleRequest: typeof native.handleRequest) => {
    native.handleRequest = handleRequest
    if (native.peer === undefined) throw new Error('native composition peer was not configured')
    return native.peer
  },
}))

interface PeerFixture {
  readonly peer: CodexPeer
  readonly requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }>
  readonly toolResults: Array<{ readonly name: string; readonly result: unknown }>
}

function nativePeer(): PeerFixture {
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = []
  const toolResults: Array<{ readonly name: string; readonly result: unknown }> = []
  const emit = (method: string, params: Record<string, unknown>): void => {
    for (const listener of listeners) listener(method, params)
  }
  const peer: CodexPeer = {
    notify() {},
    close() { listeners.clear() },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async request(method, params) {
      requests.push({ method, params: { ...params } })
      if (method === 'initialize') return {}
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test' } }
      if (method === 'model/list') return {
        data: [{ model: 'fixture-model', displayName: 'Fixture model', description: 'test model', hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }], defaultReasoningEffort: 'low' }],
      }
      if (method === 'thread/start') return { thread: { id: 'fixture-thread' } }
      if (method === 'turn/start') {
        const turnId = 'fixture-turn'
        queueMicrotask(() => {
          queueMicrotask(() => {
            void (async () => {
              const handler = native.handleRequest
              if (handler === undefined) throw new Error('Codex request handler was not installed')
              const calls = [
                { name: 'list_bots', callId: 'list-call', arguments: '{}' },
                { name: 'inspect_bot', callId: 'inspect-call', arguments: JSON.stringify({ botId: 'bot-target' }) },
                { name: 'send_bot_message', callId: 'send-call', arguments: JSON.stringify({
                  targetBotId: 'bot-target', text: 'Please report your status.', messageId: 'relay-1',
                }) },
              ]
              for (const call of calls) {
                const result = await handler('item/tool/call', {
                  threadId: 'fixture-thread', turnId, tool: call.name, callId: call.callId, arguments: call.arguments,
                })
                toolResults.push({ name: call.name, result })
              }
              emit('item/agentMessage/delta', { threadId: 'fixture-thread', turnId, itemId: 'answer', delta: 'The relay is complete.' })
              emit('turn/completed', { threadId: 'fixture-thread', turn: { id: turnId, status: 'completed' } })
            })().catch(() => {
              emit('turn/completed', { threadId: 'fixture-thread', turn: { id: turnId, status: 'failed' } })
            })
          })
        })
        return { turn: { id: turnId } }
      }
      return {}
    },
  }
  return { peer, requests, toolResults }
}

function output(result: unknown): { readonly success: boolean; readonly contentItems: readonly { readonly text: string }[] } {
  if (result === null || typeof result !== 'object') throw new Error('native tool returned no result')
  const value = result as { success?: unknown; contentItems?: unknown }
  if (typeof value.success !== 'boolean' || !Array.isArray(value.contentItems)) throw new Error('native tool result was malformed')
  return value as { readonly success: boolean; readonly contentItems: readonly { readonly text: string }[] }
}

it('composes Bot identity and Codex dynamic collaboration with sender-bound delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bot-codex-composition-'))
  const ctx = new Context()
  onTestFinished(async () => {
    native.peer?.close()
    native.peer = undefined
    native.handleRequest = undefined
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  const nativeHome = join(root, 'codex-home')
  const shellHome = join(root, 'shell-home')
  await mkdir(nativeHome, { recursive: true })
  await writeFile(join(nativeHome, 'harness-backend.json'), JSON.stringify({
    enabled: true, auto: false, tiers: {}, models: [{
      id: 'fixture-model', name: 'Fixture model', description: 'test model', efforts: [{ id: 'low', description: 'Low' }], defaultEffort: 'low', serviceTiers: [], inputModalities: ['text'],
    }],
  }))

  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {
    DSH_CODEX_BINARY: join(root, 'codex'), DSH_CODEX_HOME: nativeHome,
    DSH_CODEX_SHELL_HOME: shellHome, DSH_CODEX_CWD: root, DSH_CODEX_NODE: process.execPath,
  } }]))
  ctx.provide('subprocess', { spawn: vi.fn() } as never)
  ctx.provide('skillLibrary', { registerNativeProvider: vi.fn(() => () => {}) } as never)
  ctx.provide('codingSessions', { registerProvider: vi.fn(() => () => {}) } as never)

  const pool = new MemoryMediaPool()
  const createdAgents = new Map<SessionId, Agent>()
  const sessionController = {
    create: vi.fn(async (request: { readonly sessionId: SessionId; readonly cwd: string; readonly agentPreset?: string }) => {
      const handle = await ctx.agents.create({
        sessionId: request.sessionId,
        agentOptions: { provider: 'codex-backend', model: 'fixture-model' },
        meta: { cwd: request.cwd, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) },
        ...(request.agentPreset === undefined ? {} : {
          setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, request.agentPreset) },
        }),
      })
      const agent = handle.agent
      createdAgents.set(request.sessionId, agent)
      return { sessionId: request.sessionId }
    }),
    inspect: vi.fn(async (sessionId: SessionId) => ({ events: ctx.sessions.get(sessionId)?.snapshotEvents() ?? [] })),
    resolveAgent: vi.fn(async (sessionId: SessionId) => {
      const agent = createdAgents.get(sessionId)
      return agent === undefined ? { error: new Error(`Session ${sessionId} is not live`) } : { agent }
    }),
  }
  ctx.provide('sessionController', sessionController as never)
  ctx.provide('attachments', { readImage: vi.fn() } as never)
  ctx.provide('schedule', {
    create: vi.fn(async () => { throw new Error('schedule create was not expected in this composition test') }),
    list: vi.fn(async () => []),
    update: vi.fn(async () => { throw new Error('schedule update was not expected in this composition test') }),
    delete: vi.fn(async () => { throw new Error('schedule delete was not expected in this composition test') }),
  } as never)
  ctx.on('session/flush', () => {})
  const approval = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', approval)

  const peerFixture = nativePeer()
  native.peer = peerFixture.peer

  const storageDomainPlugin = {
    inject: ['storage'],
    apply(scope: Context): void {
      const backend: StorageBackend = new MemoryStorageBackend(pool)
      scope.effect(() => scope.storage.backend.register('fixture', backend))
      scope.effect(() => async () => { await backend.close() })
      const facility = new DomainFacility(scope, { backend: 'fixture' })
      scope.effect(() => {
        const unmount = scope.storage.mount('domain', facility)
        scope.provide('storageDomain', facility)
        return async () => { await facility.closeAll(); unmount() }
      })
    },
  }
  const modules = new Map<string, unknown>([
    ['@yharness/llm', Llm], ['@yharness/session', Sessions], ['@yharness/session-projection', Projection],
    ['@yharness/system-prompt', Prompt], ['@yharness/tools', Tools], ['@yharness/agent', Agents],
    ['@yharness/agent-loop', Loop], ['@yharness/sandbox-policy', Sandbox], ['@yharness/user-approval', ApprovalModule],
    ['@yharness/user-questions', Questions], ['@yharness/storage', StorageModule], ['@yharness/typert-registry', Typert],
    ['@yharness/fixture-storage-domain', { default: storageDomainPlugin }],
    ['@yharness/bots', { default: BotService }],
    ['@yharness/tool-schedule', ToolSchedule],
    ['@yharness/fixture-codex-connection', { default: CodexBackendConnection }],
  ])
  const configPath = join(root, 'cordis.json')
  await writeFile(configPath, JSON.stringify([
    { name: '@yharness/llm' }, { name: '@yharness/session' }, { name: '@yharness/session-projection' },
    { name: '@yharness/system-prompt' }, { name: '@yharness/tools' }, { name: '@yharness/agent' },
    { name: '@yharness/typert-registry' }, { name: '@yharness/storage' }, { name: '@yharness/fixture-storage-domain' },
    { name: '@yharness/sandbox-policy', config: { mode: 'workspace-write' } },
    { name: '@yharness/user-approval', config: { policy: 'ask' } }, { name: '@yharness/user-questions' },
    { name: '@yharness/agent-loop', config: { agents: [] } }, { name: '@yharness/bots' },
    { name: '@yharness/fixture-codex-connection' },
  ]))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import(specifier) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Bot composition module: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('Unexpected module registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job') },
    resolveSync(): never { throw new Error('Unexpected module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // The shipped `standard` preset mounts this exact plugin row. Registering
  // the focused preset here keeps the fixture small while exercising the real
  // preset scope and the Bot child-scope shadowing it must provide.
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.agentPresets.register({ id: 'standard', plugins: [{ name: '@yharness/tool-schedule' }] })
  await ctx.agentPresets.register({ id: 'minimal', plugins: [] })
  expect(ctx.agentPresets.inspectCompositions()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'standard', modules: expect.arrayContaining([
      expect.objectContaining({ moduleName: expect.stringContaining('tool-schedule') }),
    ]) }),
  ]))
  await ctx.codexBackendConnection.getState()

  const sender = await ctx.bots.create({ id: BotId('bot-sender'), name: 'Chief of staff', cwd: root, agentPreset: 'standard' })
  const target = await ctx.bots.create({ id: BotId('bot-target'), name: 'Grok bot', cwd: root, agentPreset: 'standard' })
  const minimal = await ctx.bots.create({ id: BotId('bot-minimal'), name: 'Minimal bot', cwd: root, agentPreset: 'minimal' })
  expect(ctx.get('codexDynamicTools')).toBeDefined()
  expect(ctx.llm.listProviders()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex-backend' })]))
  const senderAgent = createdAgents.get(sender.bot.sessionId)
  const targetAgent = createdAgents.get(target.bot.sessionId)
  const minimalAgent = createdAgents.get(minimal.bot.sessionId)
  if (senderAgent === undefined || targetAgent === undefined || minimalAgent === undefined) throw new Error('Bot Session agents were not created')
  const senderPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: senderAgent }))
  expect(senderPrompt).toContain('Your Bot name is "Chief of staff".')
  const presetLease = await ctx.agentPresets.acquireScope('standard')
  try {
    const presetScheduleCreate = ctx.tools.get('schedule_create', presetLease.key)
    expect(presetScheduleCreate).toBeDefined()
    expect(ctx.tools.get('schedule_create', senderAgent)).toBe(presetScheduleCreate)
  } finally {
    await presetLease[Symbol.asyncDispose]()
  }
  expect(ctx.tools.schemas(senderAgent).filter(tool => tool.name === 'schedule_create')).toHaveLength(1)
  expect(ctx.tools.schemas(senderAgent).map(tool => tool.name)).toEqual(expect.arrayContaining([
    'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
    'schedule_pause', 'schedule_resume', 'schedule_history',
  ]))
  expect(ctx.tools.get('schedule_create', senderAgent)).not.toBe(ctx.tools.get('schedule_create'))
  expect(scopeOf(senderAgent.ctx)).toBeDefined()
  expect(ctx.tools.get('schedule_create', minimalAgent)).toBeUndefined()
  const dynamicToolsForMinimal = await (ctx.get('codexDynamicTools') as BotNativeToolProvider).resolve({ sessionId: minimal.bot.sessionId })
  expect(dynamicToolsForMinimal.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
    'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
    'schedule_pause', 'schedule_resume', 'schedule_history',
  ]))

  const targetFollowup = vi.spyOn(targetAgent, 'followup').mockImplementation((message) => {
    targetAgent.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [message],
    })
  })
  senderAgent.session.append('turn/start', { turn: 1 })
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Coordinate with Grok bot.' }] })]
  const chunks: unknown[] = []
  await ctx.agents.withInitiator(senderAgent, async () => {
    for await (const chunk of ctx.llm.stream({ provider: 'codex-backend', model: 'fixture-model', sessionId: senderAgent.id, messages })) chunks.push(chunk)
  })

  const threadStart = peerFixture.requests.find(request => request.method === 'thread/start')
  if (threadStart === undefined) throw new Error(`Codex stream did not reach turn: ${JSON.stringify(chunks)}`)
  expect(threadStart?.params.dynamicTools, JSON.stringify(peerFixture.requests)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'list_bots' }), expect.objectContaining({ name: 'inspect_bot' }), expect.objectContaining({ name: 'send_bot_message' }),
    expect.objectContaining({ name: 'schedule_create' }), expect.objectContaining({ name: 'schedule_list' }),
    expect.objectContaining({ name: 'schedule_update' }), expect.objectContaining({ name: 'schedule_delete' }),
    expect.objectContaining({ name: 'schedule_pause' }), expect.objectContaining({ name: 'schedule_resume' }),
    expect.objectContaining({ name: 'schedule_history' }),
  ]))
  if (peerFixture.toolResults.length !== 3) throw new Error(`Native tool calls failed: requests=${JSON.stringify(peerFixture.requests)} chunks=${JSON.stringify(chunks)}`)
  expect(output(peerFixture.toolResults[0]?.result)).toMatchObject({ success: true })
  const listedBots = JSON.parse(output(peerFixture.toolResults[0]?.result).contentItems[0]!.text)
  expect(listedBots).toHaveLength(2)
  expect(listedBots).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'bot-target', name: 'Grok bot' }),
    expect.objectContaining({ id: 'bot-minimal', name: 'Minimal bot' }),
  ]))
  expect(output(peerFixture.toolResults[1]?.result)).toMatchObject({ success: true })
  expect(output(peerFixture.toolResults[2]?.result), JSON.stringify(peerFixture.toolResults[2])).toMatchObject({ success: true })
  expect(JSON.parse(output(peerFixture.toolResults[2]?.result).contentItems[0]!.text)).toMatchObject({ status: 'accepted', sender: { id: 'bot-sender' }, target: { id: 'bot-target' } })
  expect(targetFollowup).toHaveBeenCalledOnce()
  expect(targetFollowup.mock.calls[0]?.[0].source).toMatchObject({ kind: 'agent-message', senderSessionId: senderAgent.id })
  expect(approval).toHaveBeenCalledOnce()
  expect(chunks.some(chunk => typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'finish')).toBe(true)

  const senderEvents = senderAgent.session.snapshotEvents().filter(event => event.type === 'bot/dynamic-tool')
  expect(senderEvents).toHaveLength(6)
  expect(senderEvents.every(event => event.ignorable === undefined && event.data.sessionId === senderAgent.id)).toBe(true)
})
