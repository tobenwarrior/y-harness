import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { CodexBackendConnection } from '../src/codex-backend-connection.ts'
import type { CodexPeer } from '../src/codex-backend.ts'

const native = vi.hoisted(() => ({ start: vi.fn<typeof import('../src/codex-backend-process.ts').startCodexProcess>() }))
vi.mock('../src/codex-backend-process.ts', async original => ({
  ...await original<typeof import('../src/codex-backend-process.ts')>(), startCodexProcess: native.start,
}))
afterEach(() => { native.start.mockReset() })
const savedModel = { id: 'fixture-model', name: 'Fixture', description: '', efforts: [{ id: 'low', description: 'Low' }], serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] }

async function fixture(saved?: string, configured = true) {
  const home = await mkdtemp(join(tmpdir(), 'codex-backend-preferences-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  if (saved !== undefined) await writeFile(join(home, 'harness-backend.json'), saved, { mode: 0o600 })
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: configured ? {
    DSH_CODEX_HOME: home, DSH_CODEX_BINARY: join(home, 'fixture-never-executed.js'), DSH_CODEX_CWD: home,
    DSH_CODEX_SHELL_HOME: join(home, 'fixture-shell'), DSH_CODEX_NODE: process.execPath,
  } : {} }])
  ctx.provide('launchEnvironment', environment)
  await ctx.plugin(Llm)
  const calls: string[] = []
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const peer: CodexPeer = {
    request: async (method) => {
      calls.push(method)
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
        defaultReasoningEffort: 'low', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }], defaultServiceTier: 'priority', inputModalities: ['text'] }] }
      if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'fixture-login', userCode: 'FIXTURE', verificationUrl: 'https://auth.openai.com/codex/device' }
      return {}
    }, notify() {}, subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    close: () => { for (const callback of listeners) callback('__closed', {}); listeners.clear() },
  }
  native.start.mockReturnValue(peer)
  const fiber = await ctx.plugin(CodexBackendConnection)
  return { ctx, home, calls, fiber, connection: ctx.codexBackendConnection }
}

describe('isolated Codex backend preferences', () => {
  it('restores an older display catalog without launching a child or reading native auth', async () => {
    const f = await fixture(JSON.stringify({ enabled: true, tiers: {}, models: [savedModel] }))
    expect(await f.connection.getState()).toMatchObject({ enabled: true, connected: false, busy: false })
    expect(await f.connection.models()).toEqual([{ ...savedModel, inputModalities: ['text', 'image'] }])
    expect(f.ctx.llm.listProviders().map(provider => provider.id)).toEqual(['codex-backend'])
    expect(native.start).not.toHaveBeenCalled()
    await f.connection.configure(false, undefined, undefined)
    expect(f.ctx.llm.listProviders()).toEqual([])
    const stored: unknown = JSON.parse(await readFile(join(f.home, 'harness-backend.json'), 'utf8'))
    expect(stored).toMatchObject({ enabled: false, auto: false, models: [{ inputModalities: ['text', 'image'] }] })
    if (process.platform !== 'win32') expect((await stat(join(f.home, 'harness-backend.json'))).mode & 0o777).toBe(0o600)
  })

  it('retains current catalog defaults and modalities from display preferences', async () => {
    const current = { ...savedModel, defaultEffort: 'low', defaultServiceTier: 'priority', inputModalities: ['text'] }
    const f = await fixture(JSON.stringify({ enabled: false, auto: false, tiers: {}, models: [current] }))
    expect(await f.connection.models()).toEqual([current])
    expect(native.start).not.toHaveBeenCalled()
  })

  it('refreshes and publishes only the selected fixture profile and persists explicit choices', async () => {
    const f = await fixture()
    expect(await f.connection.models()).toEqual([])
    expect(await f.connection.getState()).toMatchObject({ enabled: false, connected: false })
    expect(native.start).not.toHaveBeenCalled()
    expect(await f.connection.refresh()).toMatchObject({ connected: true, enabled: false })
    expect(native.start.mock.calls[0]?.[0]).toMatchObject({ home: f.home, cwd: f.home, shellHome: join(f.home, 'fixture-shell') })
    expect(f.calls).toEqual(['initialize', 'account/read', 'model/list'])
    expect(await f.connection.publish()).toMatchObject({ enabled: true })
    expect(await f.ctx.llm.listModels('codex-backend')).toMatchObject([{ id: 'fixture-model', inputModalities: ['text'] }])
    expect(await f.connection.configure(true, 'fixture-model', 'priority')).toMatchObject({ tiers: { 'fixture-model': 'priority' } })
    expect(await f.connection.disconnect()).toMatchObject({ enabled: false, connected: false })
    expect(f.ctx.llm.listProviders()).toEqual([])
    expect(f.calls).toContain('account/logout')
  })

  it('requires storage consent before the synthetic device flow and cancels only its attempt', async () => {
    const f = await fixture()
    await expect(f.connection.start(false)).rejects.toThrow(/consent/)
    expect(native.start).not.toHaveBeenCalled()
    expect(await f.connection.start(true)).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FIXTURE' })
    await f.connection.cancel()
    expect(f.calls).toEqual(['initialize', 'account/login/start', 'account/login/cancel'])
    expect((await f.connection.getState()).busy).toBe(false)
  })

  it.each(['{invalid', JSON.stringify({ enabled: true, models: [] }), 'x'.repeat(2 * 1024 * 1024 + 1)])('refuses corrupt or oversized preferences before native startup', async (saved) => {
    const f = await fixture(saved)
    await expect(f.connection.getState()).rejects.toThrow(/preferences could not be read/)
    expect(native.start).not.toHaveBeenCalled()
  })

  it('fails explicitly without an isolated deployment and closes disposed controls', async () => {
    const missing = await fixture(undefined, false)
    await expect(missing.connection.getState()).rejects.toThrow(/isolated Codex backend/)
    const ready = await fixture()
    await ready.connection.getState()
    await ready.fiber.dispose()
    await expect(ready.connection.models()).rejects.toThrow(/closed/)
  })
})
