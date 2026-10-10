/** Real process-owner code with only confinement and managed subprocess boundaries mocked. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { it, expect, onTestFinished, vi } from 'vitest'
import { SandboxProvider, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, { type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ClaudeRootProcess } from '../src/root-process.ts'

async function fixture(options: { deferred?: boolean; enforcement?: 'full' | 'partial'; unconfirmed?: boolean; heldRange?: boolean; missingPipe?: boolean; stuckCommand?: boolean } = {}) {
  const ctx = new Context(); const confine = Promise.withResolvers<undefined>()
  const exit = Promise.withResolvers<SubprocessOutcome>(); const range = Promise.withResolvers<boolean>()
  const lifetime = new AbortController(); const spawned: SubprocessSpawnSpec[] = []
  const stdin = new PassThrough(); const stdout = new PassThrough()
  let current = true; let waits = 0
  const terminate = vi.fn(() => { if (!options.stuckCommand) exit.resolve({ exitCode: 0, signal: null }) })
  class Confine extends SandboxProvider {
    override async confine(argv: readonly string[], _policy: SandboxPolicy, signal?: AbortSignal) {
      if (options.deferred) await new Promise<void>((resolve, reject) => {
        const abort = () => { reject(new Error('cancelled confinement')) }
        signal?.addEventListener('abort', abort, { once: true })
        void confine.promise.then(() => { signal?.removeEventListener('abort', abort); resolve() })
      })
      return { argv: ['fixture-confine', ...argv], enforcement: options.enforcement ?? 'full', denialSignatures: [], runnerFailureRules: [] }
    }
  }
  class Processes extends SubprocessRuntime {
    override resolveExecutable(): never { throw new Error('unexpected resolve') }
    override terminalEnvironment(): never { throw new Error('unexpected terminal') }
    override spawnTerminal(): never { throw new Error('unexpected terminal') }
    override spawn(spec: SubprocessSpawnSpec) {
      spawned.push(spec)
      return {
        stdin: options.missingPipe ? undefined : stdin, stdout, stderr: undefined, control: undefined,
        collected: {}, done: exit.promise, terminate,
        waitForExit: async (signal?: AbortSignal) => {
          waits++
          if (options.unconfirmed) return await new Promise<boolean>((resolve) => {
            if (signal?.aborted) resolve(false)
            else signal?.addEventListener('abort', () => { resolve(false) }, { once: true })
          })
          if (options.heldRange) return range.promise
          await exit.promise; return true
        } }
    }
  }
  await ctx.plugin(Confine); await ctx.plugin(Processes)
  const process = new ClaudeRootProcess(ctx, { command: '/fixture/claude', args: [], cwd: '/fixture', env: {}, signal: lifetime.signal }, { mode: 'workspace-write', workspaceRoot: '/fixture' }, 5, lifetime.signal, () => current, { lineBytes: 16, lifetimeBytes: 64 })
  onTestFinished(async () => {
    process.kill('SIGTERM'); confine.resolve(undefined); range.resolve(true)
    await Promise.allSettled([process.done]); await ctx.fiber.dispose()
  })
  return { process, spawned, confine, range, stdout, terminate, lifetime, stale: () => { current = false }, get waits() { return waits } }
}

it('cancels pending confinement without starting any child', async () => {
  const f = await fixture({ deferred: true }); f.process.kill('SIGTERM')
  await expect(f.process.done).rejects.toThrow(); expect(f.spawned).toEqual([]); expect(f.process.quiescent).toBe(true)
})
it('rechecks authority after deferred confinement before spawning', async () => {
  const f = await fixture({ deferred: true }); f.stale(); f.confine.resolve(undefined)
  await expect(f.process.done).rejects.toThrow(/policy changed/); expect(f.spawned).toEqual([])
})
it('refuses partial confinement without starting a child', async () => {
  const f = await fixture({ enforcement: 'partial' }); await expect(f.process.done).rejects.toThrow(/complete/); expect(f.spawned).toEqual([])
})
it.each([Buffer.alloc(17, 65), Buffer.from('多'.repeat(6))])('bounds complete wire lines before any JSON parser and drains the managed range', async (bytes) => {
  const f = await fixture({ heldRange: true }); await vi.waitFor(() => { expect(f.spawned).toHaveLength(1) })
  let done = false; void f.process.done.then(() => { done = true }, () => { done = true })
  f.stdout.write(bytes); await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled() }); expect(done).toBe(false)
  f.range.resolve(true); await Promise.allSettled([f.process.done]); expect(f.process.quiescent).toBe(true)
})
it('bounds observation of an unconfirmed managed range and retains failed ownership', async () => {
  const f = await fixture({ unconfirmed: true, stuckCommand: true })
  await vi.waitFor(() => { expect(f.spawned).toHaveLength(1) }); f.process.kill('SIGTERM')
  const drained = (async () => {
    for await (const _chunk of f.process.stdout) { /* SDK transport consumes the owned stream until it closes. */ }
  })()
  await expect(f.process.done).rejects.toThrow(/quiescence/); await drained
  expect(f.waits).toBe(1); expect(f.process.quiescent).toBe(false)
})
it('terminates and confirms the range when a required protocol pipe is absent', async () => {
  const f = await fixture({ missingPipe: true }); await expect(f.process.done).rejects.toThrow(/piped/)
  expect(f.terminate).toHaveBeenCalled(); expect(f.process.quiescent).toBe(true)
})
