/** Actual configured-source plugin and services; all source files/process streams are owned fixtures. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Sandbox from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import CodingSessions from '@deepseek-ai/dsh-coding-session'
import * as OriginalSource from '../src/coding-session-source.ts'
import { CodexSessionSourceReleaseError } from '../src/codex-session-source-process.ts'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import type { CodingSessionOwnerToken, CodingSessionProvider, CodingSessionSource } from '@deepseek-ai/dsh-coding-session/types'

async function fixture(range = true) {
  const home = await mkdtemp(join(tmpdir(), 'codex-source-plugin-lifecycle-')); const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  await mkdir(join(home, 'bin'))
  const wrapper = Buffer.from('Owned synthetic wrapper, never executed.'); const binary = join(home, 'bin/codex.js')
  await writeFile(binary, wrapper); const packageManifest = join(home, 'package.json')
  await writeFile(packageManifest, JSON.stringify({ name: '@openai/codex', version: '0.160.0', bin: { codex: 'bin/codex.js' } }))
  const config: CodexSessionSourceConfig = { id: 'owned-source', label: 'Owned source', home: join(home, 'native'), cwd: home,
    binary, packageManifest, binarySha256: createHash('sha256').update(wrapper).digest('hex'), version: '0.160.0',
    nodePath: process.execPath, shellHome: join(home, 'shell'), graceMs: 100 }
  const errors: unknown[] = []; ctx.logger.exporter({ export: (message) => {
    if (message.type !== 'error') return
    for (const value of message.args) { const error: unknown = value; errors.push(error) }
  } })
  const frames: string[] = []; const terminate = vi.fn(); const waitForExit = vi.fn(async () => range)
  const processes: Array<{ stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = []
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
    processes.push({ stdin, stdout, stderr })
    const completed = Promise.withResolvers<Awaited<SubprocessHandle['done']>>()
    let pending = ''
    stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) return
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        const frame: unknown = JSON.parse(line)
        if (frame === null || typeof frame !== 'object') throw new Error('Fixture protocol requires an object')
        const method: unknown = Reflect.get(frame, 'method'); const id: unknown = Reflect.get(frame, 'id')
        if (typeof method !== 'string') throw new Error('Fixture protocol requires a method')
        frames.push(method)
        if (id === undefined) continue
        const result = method === 'initialize'
          ? { codexHome: config.home, userAgent: 'y-coding-session-reader/0.160.0 (fixture)' }
          : { data: [], nextCursor: null }
        queueMicrotask(() => { if (!stdout.destroyed) stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') })
      }
    })
    const finish = (): void => {
      terminate(); stdin.end(); stdout.end(); stderr.end(); completed.resolve({ exitCode: 0, signal: null })
    }
    onTestFinished(finish)
    expect(spec.argv.slice(0, 2)).toEqual([config.nodePath, binary])
    return { stdin, stdout, stderr, done: completed.promise, collected: {}, control: undefined,
      terminate: finish, waitForExit }
  })
  class FixtureSubprocess extends SubprocessRuntime {
    async resolveExecutable(): Promise<never> { throw new Error('Fixture executable lookup is unavailable') }
    async terminalEnvironment(): Promise<never> { throw new Error('Fixture terminal inspection is unavailable') }
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle { return spawn(spec) }
    async spawnTerminal(): Promise<never> { throw new Error('Fixture terminal spawning is unavailable') }
  }
  await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root: join(home, 'storage') })
  await ctx.plugin(Domain, { backend: 'json' }); await ctx.plugin(Typert)
  await ctx.plugin(CodingSessions, { ...CodingSessions.Config(), enableClaudeDiscovery: false }); await ctx.plugin(FixtureSubprocess)
  onTestFinished(() => { for (const process of processes) { process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy() } })
  return { ctx, config, errors, spawn, frames, terminate, waitForExit }
}

describe('Codex configured-source registration and uncertain teardown', () => {
  it.each(['no-agents', 'no-initiator', 'child', 'root'] as const)(
    'checks exact real root authority for a separately declared synthetic source: %s', async (authority) => {
      const f = await fixture(); await mkdir(f.config.home)
      let provider: CodingSessionProvider | undefined
      const register = f.ctx.codingSessions.registerProvider.bind(f.ctx.codingSessions)
      const registration = vi.spyOn(f.ctx.codingSessions, 'registerProvider').mockImplementation((value) => {
        provider = value; return register(value)
      })
      onTestFinished(() => { registration.mockRestore() })
      // This declaration describes only the empty, generated profile and synthetic launcher in this fixture.
      await f.ctx.plugin(OriginalSource, { sources: [{ ...f.config, enableSequentialProjectFiles: true,
        knownNoManagedFeatureOverrides: true }] })
      const profile = (await f.ctx.codingSessions.getState()).sources[0]
      if (profile === undefined || provider?.sequentialWriter === undefined) throw new Error('Fixture sequential source was not registered')
      const source: CodingSessionSource = { provider: 'codex', profileId: profile.profileId,
        nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('owned-native-session') }
      const writer = provider.sequentialWriter
      const acquire = () => writer.acquire(source, { signal: new AbortController().signal,
        ownerToken: brandString<CodingSessionOwnerToken>('owned-fixture-owner'), nativeProfileUnchanged: true,
        limit: 10, maxEvents: 100, maxBytes: 64 * 1024 })
      if (authority === 'no-agents') {
        await expect(acquire()).rejects.toThrow('exact live idle Harness root')
        expect(f.spawn).not.toHaveBeenCalled(); return
      }
      await mountAgentLoopTestDependencies(f.ctx)
      await f.ctx.plugin(Sandbox, { mode: 'read-only', workspaceRoot: f.config.cwd })
      await f.ctx.plugin(Approval, { policy: 'never' })
      const harness = await mountAgentLoopTestHarness(f.ctx)
      if (authority === 'no-initiator') {
        await expect(acquire()).rejects.toThrow('exact live idle Harness root')
        expect(f.spawn).not.toHaveBeenCalled(); return
      }
      const root = await harness.create(SessionId('configured-source-real-root'), {}, { cwd: f.config.cwd })
      if (authority === 'child') {
        const child = await f.ctx.agents.create({ sessionId: SessionId('configured-source-real-child'),
          parentAgent: root, meta: { cwd: f.config.cwd } })
        expect(f.ctx.agents.roots()).not.toContain(child.agent)
        await expect(f.ctx.agents.withInitiator(child.agent, acquire)).rejects.toThrow('exact live idle Harness root')
        expect(f.spawn).not.toHaveBeenCalled(); return
      }
      // A real idle root reaches the real managed-peer factory, which refuses the fixture's reader-only handshake.
      await expect(f.ctx.agents.withInitiator(root, acquire)).rejects.toThrow('home or pinned version')
      expect(f.spawn).toHaveBeenCalledOnce()
      expect(f.frames).toEqual(['initialize'])
      expect(f.waitForExit).toHaveBeenCalledOnce()
      expect(f.ctx.get('approval')?.config.policy).toBe('never')
    })

  it('rejects duplicate configured IDs while keeping native execution dormant', async () => {
    const f = await fixture()
    const owner = f.ctx.plugin(OriginalSource, { sources: [f.config, { ...f.config }] })
    await expect(owner.await()).rejects.toThrow('source IDs must be distinct')
    expect(f.spawn).not.toHaveBeenCalled()
    await owner.dispose()
    expect((await f.ctx.codingSessions.getState()).sources).toEqual([])
  })

  it.each([false, true])('retains actual read-process release uncertainty through plugin disposal (unregister fails=%s)', async (failUnregister) => {
    const f = await fixture(false)
    const register = f.ctx.codingSessions.registerProvider.bind(f.ctx.codingSessions)
    const unregister = vi.fn(async (remove: () => Promise<void>) => {
      await remove()
      if (failUnregister) throw new Error('Owned registration cleanup failure')
    })
    const registration = vi.spyOn(f.ctx.codingSessions, 'registerProvider').mockImplementation((provider) => {
      const remove = register(provider)
      return () => unregister(remove)
    })
    onTestFinished(() => { registration.mockRestore() })
    const owner = await f.ctx.plugin(OriginalSource, { sources: [f.config] })
    const source = (await f.ctx.codingSessions.getState()).sources[0]
    if (source === undefined) throw new Error('Fixture source was not registered')
    expect(f.spawn).not.toHaveBeenCalled()
    await expect(f.ctx.codingSessions.discover(source)).rejects.toBeInstanceOf(CodexSessionSourceReleaseError)
    expect(f.frames).toEqual(['initialize', 'initialized', 'thread/list'])
    expect(f.waitForExit).toHaveBeenCalledOnce()
    expect((await f.ctx.codingSessions.getState()).sources[0]?.connected).toBe(false)
    await owner.dispose()
    expect(unregister).toHaveBeenCalledOnce()
    expect((await f.ctx.codingSessions.getState()).sources).toEqual([])
    // Cordis's public logger exports each aggregate member separately.
    expect(f.errors).toHaveLength(failUnregister ? 2 : 1)
    expect(f.errors.some(error => error instanceof CodexSessionSourceReleaseError)).toBe(true)
    if (failUnregister) expect(f.errors).toContainEqual(new Error('Owned registration cleanup failure'))
    expect(f.spawn).toHaveBeenCalledOnce()
  })
})
