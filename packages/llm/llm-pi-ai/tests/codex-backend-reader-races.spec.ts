/** Reader and device-notification races on one in-memory peer; never opens auth or a native process. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { CodexBackendRuntime, declineCodexRequest } from '../src/codex-backend.ts'
import type { CodexPeer } from '../src/codex-backend.ts'

function fixture() {
  const callbacks = new Set<(method: string, params: Record<string, unknown>) => void>()
  const reply = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'model/list') return { data: [{ model: 'fixture-model' }] }
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'fixture-login',
      userCode: 'FIXTURE', verificationUrl: 'https://auth.openai.com/codex/device' }
    return {}
  })
  const peer: CodexPeer = { request: method => reply(method), notify() {}, close() {},
    subscribe: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback) } } }
  const runtime = new CodexBackendRuntime({ preferences: { enabled: false, models: [], tiers: {} },
    connect: async () => peer, persist: async () => {},
    resolveAccess: () => ({ cwd: '/fixture/project', sandbox: 'read-only', writableRoots: [], approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }, request: declineCodexRequest }) })
  onTestFinished(() => { runtime.close() })
  return { runtime, reply, emit: (method: string, params: Record<string, unknown> = {}) => {
    for (const callback of callbacks) callback(method, params)
  } }
}

describe('Codex connected history and skill inventory races', () => {
  it('returns a supported history response from its captured still-current connection', async () => {
    const f = fixture(); await f.runtime.refresh()
    const reader = f.runtime.codingSessionReader()!
    f.reply.mockResolvedValue({ thread: { id: 'fixture-original', turns: [] } })
    expect(await reader.request('thread/read', { threadId: 'fixture-original' })).toEqual({ thread: { id: 'fixture-original', turns: [] } })
    expect(reader.connected()).toBe(true)
  })

  it('refuses relative native skill project paths without sending an inventory request', async () => {
    const f = fixture(); await f.runtime.refresh(); f.reply.mockClear()
    expect(await f.runtime.listSkills([{ id: 'fixture-project', title: 'Fixture', path: 'relative/project' }])).toMatchObject({
      entries: [], status: { state: 'unavailable' },
    })
    expect(f.reply).not.toHaveBeenCalled()
  })

  it.each([false, true])('discards a skill response from a lost connection, response rejects=%s', async (reject) => {
    const f = fixture(); await f.runtime.refresh(); const response = Promise.withResolvers<unknown>()
    f.reply.mockImplementation(() => response.promise)
    const pending = f.runtime.listSkills([{ id: 'fixture-project', title: 'Fixture', path: '/fixture/project' }])
    f.emit('__closed')
    if (reject) response.reject(new Error('Private fixture diagnostic'))
    else response.resolve({ data: [] })
    expect(await pending).toMatchObject({ entries: [], status: { state: 'disconnected' } })
    expect(f.runtime.codingSessionReader()).toBeUndefined()
  })

  it('reports a failed status refresh after successful matching device completion without native diagnostics', async () => {
    const f = fixture(); await f.runtime.login(true)
    f.reply.mockRejectedValue(new Error('Private fixture diagnostic'))
    f.emit('account/login/completed', { loginId: 'fixture-login', success: true })
    await vi.waitFor(() => {
      expect(f.runtime.view()).toMatchObject({ busy: false, error: 'Sign-in completed; refresh the Codex backend to read its status.' })
    })
    expect(JSON.stringify(f.runtime.view())).not.toContain('Private fixture diagnostic')
  })

  it('refreshes connected account and model metadata after matching successful device completion', async () => {
    const f = fixture(); await f.runtime.login(true); f.reply.mockClear()
    f.emit('account/login/completed', { loginId: 'fixture-login', success: true })
    await vi.waitFor(() => { expect(f.runtime.view()).toMatchObject({ connected: true, busy: false }) })
    await vi.waitFor(() => { expect(f.runtime.models().map(model => model.id)).toEqual(['fixture-model']) })
    expect(f.reply.mock.calls.map(([method]) => method)).toEqual(['account/read', 'model/list'])
  })
})
