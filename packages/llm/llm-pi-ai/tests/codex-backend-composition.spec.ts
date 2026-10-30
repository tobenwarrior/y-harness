/** Native request forwarding through Loader-owned policies and the production agent loop. */
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@yharness/cordis'
import Loader, { type ModuleLoaderV2 } from '@yharness/cordis-plugin-loader'
import Include from '@yharness/cordis-plugin-include'
import Llm from '@yharness/llm'
import { createUserMessage } from '@yharness/llm'
import Sessions, { SessionId } from '@yharness/session'
import Projections from '@yharness/session-projection'
import Prompt from '@yharness/system-prompt'
import Tools from '@yharness/tools'
import Agents from '@yharness/agent'
import Loop from '@yharness/agent-loop'
import Sandbox from '@yharness/sandbox-policy'
import Approval from '@yharness/user-approval'
import Questions from '@yharness/user-questions'
import { CodexBackendAdapter, CodexBackendRuntime } from '../src/codex-backend.ts'
import { resolveCodexAccess } from '../src/codex-backend-access.ts'

it('routes native approvals and questions to the calling session through a real Loader composition', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@yharness/llm', Llm], ['@yharness/session', Sessions],
    ['@yharness/session-projection', Projections], ['@yharness/system-prompt', Prompt],
    ['@yharness/tools', Tools], ['@yharness/agent', Agents],
    ['@yharness/sandbox-policy', Sandbox], ['@yharness/user-approval', Approval],
    ['@yharness/user-questions', Questions], ['@yharness/agent-loop', Loop],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import(specifier) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Codex composition module: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('Unexpected module registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job') },
    resolveSync(): never { throw new Error('Unexpected module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/codex-access.yml', import.meta.url).href } })
  await ctx.loader.await()
  const replies: unknown[] = []
  const requests: Array<{ method: string; params: object }> = []
  let nativeRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const emit = (method: string, params: Record<string, unknown>) => { for (const listener of listeners) listener(method, params) }
  const runtime = new CodexBackendRuntime({
    preferences: { enabled: true, tiers: {}, models: [{ id: 'native', name: 'Native', description: '', efforts: [{ id: 'low', description: 'Low' }], defaultEffort: 'low', serviceTiers: [], inputModalities: ['text'] }] },
    persist: async () => {}, resolveAccess: options => resolveCodexAccess(ctx, options),
    connect: async (handler) => {
      nativeRequest = handler
      return {
        notify() {}, close() { listeners.clear() },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
        async request(method, params) {
          requests.push({ method, params })
          if (method === 'account/read') return { account: { type: 'chatgpt' } }
          if (method === 'thread/start') return { thread: { id: 'native-thread' } }
          if (method === 'turn/start') {
            const identity = { threadId: 'native-thread', turnId: 'native-turn', itemId: 'item' }
            queueMicrotask(() => {
              void (async () => {
                emit('item/started', { ...identity, item: { id: 'item', type: 'fileChange', changes: [{ path: 'output', diff: '+new' }] } })
                for (const approvalMethod of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
                  replies.push(await nativeRequest(approvalMethod, { ...identity, command: 'touch output', permissions: { fileSystem: { write: ['/extra'] } } }))
                }
                replies.push(await nativeRequest('item/tool/requestUserInput', { ...identity,
                  questions: [{ id: 'choice', header: 'Choice', question: 'Which?', options: [{ label: 'first', description: '' }] }] }))
                emit('item/agentMessage/delta', { ...identity, delta: 'Native complete' })
              })().then(() => { emit('turn/completed', { ...identity, turn: { id: 'native-turn', status: 'completed' } }) },
                () => { emit('turn/completed', { ...identity, turn: { id: 'native-turn', status: 'failed' } }) })
            })
            return { turn: { id: 'native-turn' } }
          }
          return {}
        },
      }
    },
  })
  onTestFinished(() => { runtime.close() })
  const registration = ctx.llm.registerAdapter(['codex-backend'], new CodexBackendAdapter(runtime))
  onTestFinished(() => { registration() })
  const agent = await ctx.agentLoop.create(SessionId('native-composition'), { provider: 'codex-backend', model: 'native' }, { cwd: process.cwd() })
  ctx.on('approval/request', async (request) => { expect(request.agent).toBe(agent); return 'allowed-once' })
  ctx.on('user-questions/request', async (request) => {
    expect(request.agent).toBe(agent)
    return { answers: [{ id: 'choice', selected: ['first'], custom: 'detail' }] }
  })
  const visible: string[] = []
  const failures: unknown[] = []
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') failures.push(event.data.reason.error)
    if (event.type === 'assistant/message') for (const block of event.data.message.content) if (block.type === 'text') visible.push(block.text)
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the native workflow.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(failures).toEqual([])
  expect(visible).toEqual(['Native complete'])
  expect(replies).toEqual([{ decision: 'accept' }, { decision: 'accept' },
    { permissions: { fileSystem: { write: ['/extra'] } }, scope: 'turn' }, { answers: { choice: { answers: ['first', 'detail'] } } }])
  expect(requests.find(request => request.method === 'thread/start')?.params).toMatchObject({ cwd: process.cwd(), sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  expect(requests.find(request => request.method === 'turn/start')?.params).toMatchObject({ cwd: process.cwd(), sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } })
  expect(JSON.stringify(requests)).not.toContain('approval requests are declined')
  expect(await nativeRequest!('item/commandExecution/requestApproval', { threadId: 'native-thread', turnId: 'native-turn' })).toEqual({ decision: 'decline' })
})
