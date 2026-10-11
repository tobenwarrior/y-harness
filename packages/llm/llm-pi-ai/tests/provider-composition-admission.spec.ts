import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as LlmPiAi from '../src/index.ts'

const native = vi.hoisted(() => ({ start: vi.fn<typeof import('../src/codex-backend-process.ts').startCodexProcess>() }))
vi.mock('../src/codex-backend-process.ts', async original => ({
  ...await original<typeof import('../src/codex-backend-process.ts')>(), startCodexProcess: native.start,
}))
afterEach(() => { native.start.mockReset() })

describe('provider composition local admission', () => {
  it('adds and removes a public Nous client choice without creating a route or attempting authorization', async () => {
    const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
    await ctx.plugin(LlmRuntime)
    const config = await liveConfig(ctx, LlmPiAi, {})
    await config.replace({ nousClientId: 'fixture-public-client' })
    expect(ctx.llm.listProviders()).toEqual([])
    await config.replace({})
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.get('nousConnection')).toBeUndefined()
    expect(native.start).not.toHaveBeenCalled()
  })

  it('mounts an explicitly isolated Codex control from launch metadata while keeping native execution dormant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-composition-admission-')); const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {
      DSH_CODEX_BINARY: join(dir, 'never-executed.js'), DSH_CODEX_HOME: dir, DSH_CODEX_CWD: dir,
      DSH_CODEX_SHELL_HOME: join(dir, 'shell'), DSH_CODEX_NODE: process.execPath,
    } }]))
    await ctx.plugin(LlmRuntime); await ctx.plugin(LlmPiAi)
    await expect.poll(() => ctx.get('codexBackendConnection')).toBeDefined()
    expect(await ctx.codexBackendConnection.getState()).toMatchObject({ connected: false, enabled: false, running: 0 })
    expect(ctx.llm.listProviders()).toEqual([])
    expect(native.start).not.toHaveBeenCalled()
  })
})
