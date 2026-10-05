import { describe, expect, it, vi } from 'vitest'
import { parseCodexModels, declineCodexRequest, projectCodexHistory, CodexBackendRuntime } from '../src/codex-backend.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const catalog = { data: [{ id: 'sol-id', model: 'gpt-6.1-sol', displayName: 'Sol', description: 'Native', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Max' }, { reasoningEffort: 'ultra', description: 'Delegation' }], defaultReasoningEffort: 'max', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'More usage' }] }, { id: 'hidden', model: 'hidden', hidden: true }] }
function fixture() {
 const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
 const request = vi.fn(async (method: string, _params: object): Promise<unknown> => {
  if (method === 'initialize') return { userAgent: 'codex' }
  if (method === 'model/list') return catalog
  if (method === 'account/read') return { account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' } }
  if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' }
  if (method === 'thread/start') return { thread: { id: 'thread1' } }
  if (method === 'turn/start') { queueMicrotask(() => { for (const cb of listeners) { cb('item/agentMessage/delta', { threadId: 'thread1', turnId: 'turn1', itemId: 'i1', delta: 'hello' }); cb('turn/completed', { threadId: 'thread1', turn: { id: 'turn1', status: 'completed', error: null } }) } }); return { turn: { id: 'turn1' } } }
  return {}
 })
 const peer = { request, notify: vi.fn(), subscribe: (cb: (method: string, params: Record<string, unknown>) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }, close: vi.fn() }
 const runtime = new CodexBackendRuntime({ connect: async () => peer, cwd: '/isolated/project', persist: async () => {}, preferences: { enabled: false, models: [], tiers: {} } })
 return { runtime, request, peer, emit: (method: string, params: Record<string, unknown>) => { for (const cb of listeners) cb(method, params) } }
}
describe('Codex native backend', () => {
 it('preserves real model IDs, Ultra and native Fast; filters hidden entries', () => {
  expect(parseCodexModels(catalog)).toEqual([{ id: 'gpt-6.1-sol', name: 'Sol', description: 'Native', efforts: [{ id: 'max', description: 'Max' }, { id: 'ultra', description: 'Delegation' }], defaultEffort: 'max', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'More usage' }] }])
 })
 it('declines command and patch approvals and grants no permission extensions', async () => {
  expect(await declineCodexRequest('item/commandExecution/requestApproval', {})).toEqual({ decision: 'decline' })
  expect(await declineCodexRequest('item/fileChange/requestApproval', {})).toEqual({ decision: 'decline' })
  expect(await declineCodexRequest('item/permissions/requestApproval', {})).toEqual({ permissions: {}, scope: 'turn' })
  await expect(declineCodexRequest('account/chatgptAuthTokens/refresh', {})).rejects.toThrow()
 })
 it('does not start a subprocess on state/catalog reads', async () => { const { runtime, request } = fixture(); expect(runtime.view().enabled).toBe(false); expect(runtime.models()).toEqual([]); expect(request).not.toHaveBeenCalled() })
 it('requires consent before device flow and reports only display-safe account metadata', async () => {
  const { runtime, request } = fixture(); await expect(runtime.login(false)).rejects.toThrow('consent'); expect(request).not.toHaveBeenCalled()
  const login = await runtime.login(true); expect(login.userCode).toBe('CODE'); expect(runtime.view().busy).toBe(true)
  await runtime.cancel(); expect(request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'login' }); expect(runtime.view().busy).toBe(false)
 })
 it('initializes under its own client name and never sends a turn during refresh', async () => {
  const { runtime, request, peer } = fixture(); await runtime.refresh(); expect(peer.notify).toHaveBeenCalledWith('initialized'); expect(request.mock.calls[0]?.[1]).toMatchObject({ clientInfo: { name: 'deepseek-harness-local' } }); expect(runtime.view().connected).toBe(true); expect(JSON.stringify(runtime.view())).not.toContain('accessToken'); expect(request.mock.calls.map(x => x[0])).not.toContain('turn/start')
 })
 it('rejects unsupported images rather than silently losing attachments', () => { expect(() => projectCodexHistory([{ role: 'user', content: [{ type: 'image' }] }] as never)).toThrow('text') })
 it('streams native answer and sends exact Ultra with restrictive policy, no Harness tools', async () => {
  const { runtime, request } = fixture(); await runtime.refresh(); await runtime.configure(true, 'gpt-6.1-sol', 'priority')
  const chunks = []; for await (const chunk of runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', reasoningEffort: ReasoningEffortId('ultra'), system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt' }] }], tools: [{ name: 'shell', description: 'Harness shell', parameters: {} }] })) chunks.push(chunk)
  const turn = request.mock.calls.find(x => x[0] === 'turn/start')?.[1]
  expect(turn).toMatchObject({ effort: 'ultra', serviceTier: 'fast', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }); expect(turn).not.toHaveProperty('tools'); expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' }); expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
 })
 it('rejects missing or unadvertised efforts instead of converting Ultra to Max', async () => {
  const { runtime } = fixture(); await runtime.refresh(); await runtime.configure(true); const call = runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', reasoningEffort: ReasoningEffortId('invented'), messages: [] }); await expect(call.next()).rejects.toThrow('effort')
 })
})

it('interrupts a cancelled native turn and releases the active-operation guard', async () => {
 const { runtime, request } = fixture(); await runtime.refresh(); await runtime.configure(true)
 const started = Promise.withResolvers<void>()
 const original = request.getMockImplementation()!
 request.mockImplementation(async (method, params) => {
  if (method === 'turn/start') { started.resolve(); return { turn: { id: 'turn1' } } }
  return original(method, params)
 })
 const controller = new AbortController()
 const stream = runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt' }] }], signal: controller.signal })
 const next = stream.next(); await started.promise; controller.abort()
 await expect(next).rejects.toThrow(); expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread1', turnId: 'turn1' }); expect(runtime.view().running).toBe(0)
})
it('seeds a new native thread after history changes and reuses only a matching replay marker', async () => {
 const { runtime, request } = fixture(); await runtime.refresh(); await runtime.configure(true)
 const user = { role: 'user', content: [{ type: 'text', text: 'one' }] } as const
 const collect = async (messages: unknown[]) => { const chunks = []; for await (const chunk of runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', sessionId: 'session' as never, messages: messages as never })) chunks.push(chunk); return chunks }
 const chunks = await collect([user]); const finish = chunks.at(-1) as { replayState: unknown }
 const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'codex-backend', model: 'gpt-6.1-sol', replayState: finish.replayState } }
 await collect([user, assistant, { role: 'user', content: [{ type: 'text', text: 'two' }] }])
 expect(request.mock.calls.filter(x => x[0] === 'thread/start')).toHaveLength(1)
 const inputs = request.mock.calls.filter(x => x[0] === 'turn/start').map(x => (x[1] as { input: { text: string }[] }).input[0]?.text)
 expect(inputs).toEqual(['one', 'two'])
 await collect([{ ...user, content: [{ type: 'text', text: 'edited' }] }, assistant, { role: 'user', content: [{ type: 'text', text: 'branch' }] }])
 expect(request.mock.calls.filter(x => x[0] === 'thread/start')).toHaveLength(2)
})
