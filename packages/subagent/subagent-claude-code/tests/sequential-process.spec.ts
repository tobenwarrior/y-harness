/** Managed process and full pipe drainage are exercised with only external spawn/confinement mocked. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SandboxProvider, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, { type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ClaudeRootProcess } from '../src/root-process.ts'

async function fixture() {
  const ctx = new Context(); const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough()
  const exit = Promise.withResolvers<SubprocessOutcome>(); const range = Promise.withResolvers<boolean>()
  const spawned = Promise.withResolvers<SubprocessSpawnSpec>(); const lifetime = new AbortController()
  const policies: SandboxPolicy[] = []
  const terminate = vi.fn(() => { exit.resolve({ exitCode: 0, signal: null }) })
  const waitForExit = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(async (signal) => {
    if (signal === undefined) return range.promise
    if (signal.aborted) return false
    const aborted = Promise.withResolvers<boolean>()
    const onAbort = () => { aborted.resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    try { return await Promise.race([range.promise, aborted.promise]) }
    finally { signal.removeEventListener('abort', onAbort) }
  })
  let spawnSignal: AbortSignal | undefined
  class Confine extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy) {
      policies.push(policy); return { argv: ['fixture-confine', ...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }
    }
  }
  class Processes extends SubprocessRuntime {
    override resolveExecutable(): never { throw new Error('No executable discovery') }
    override terminalEnvironment(): never { throw new Error('No terminal') }
    override spawnTerminal(): never { throw new Error('No terminal') }
    override spawn(spec: SubprocessSpawnSpec) {
      spawnSignal = spec.signal
      spawnSignal?.addEventListener('abort', terminate, { once: true })
      spawned.resolve(spec)
      return { stdin, stdout, stderr, control: undefined, collected: {}, done: exit.promise, terminate, waitForExit }
    }
  }
  await ctx.plugin(Confine); await ctx.plugin(Processes)
  const process = new ClaudeRootProcess(ctx, { command: '/fixture/node', args: ['/fixture/cli'], cwd: '/fixture/project', env: {}, signal: lifetime.signal },
    { mode: 'workspace-write', workspaceRoot: '/fixture/native/projects/project' }, 5, lifetime.signal,
    () => true, { lineBytes: 1000, lifetimeBytes: 4000 }, true)
  process.stdout.resume()
  onTestFinished(async () => {
    spawnSignal?.removeEventListener('abort', terminate)
    process.kill('SIGTERM'); stdout.end(); stderr.end(); range.resolve(true); exit.resolve({ exitCode: 0, signal: null })
    await Promise.allSettled([process.done]); stdin.end(); await ctx.fiber.dispose()
  })
  return { process, stdout, stderr, exit, range, spawned, terminate, waitForExit, lifetime, policies }
}

it('waits beyond direct child exit until actual stdout, stderr and the managed range drain', async () => {
  const f = await fixture(); const spec = await f.spawned.promise
  expect(spec.cwd).toBe('/fixture/project'); expect(f.policies[0]?.workspaceRoot).toBe('/fixture/native/projects/project')
  expect(spec.stdio.stderr).toBe('pipe')
  let settled = false; void f.process.done.then(() => { settled = true }, () => { settled = true })
  f.exit.resolve({ exitCode: 0, signal: null }); await Promise.resolve(); expect(settled).toBe(false)
  f.stdout.end('owned frame\n'); await Promise.resolve(); expect(settled).toBe(false)
  f.stderr.end(); await vi.waitFor(() => { expect(f.waitForExit).toHaveBeenCalled() }); expect(settled).toBe(false)
  expect(f.terminate).not.toHaveBeenCalled()
  f.range.resolve(true); await f.process.done
  expect(f.process).toMatchObject({
    outputDrained: true, quiescent: true, diagnosticOutput: false, killed: false, exitCode: 0, signalCode: null,
  })
  expect(f.terminate).not.toHaveBeenCalled()
})

it('rejects a surviving managed range that requires termination after direct zero exit and pipe drainage', async () => {
  const f = await fixture(); await f.spawned.promise
  f.waitForExit.mockResolvedValueOnce(false)
  const refused = expect(f.process.done).rejects.toThrow('required termination')
  let settled = false; void f.process.done.then(() => { settled = true }, () => { settled = true })
  f.exit.resolve({ exitCode: 0, signal: null }); f.stdout.end(); f.stderr.end()
  await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled(); expect(f.waitForExit).toHaveBeenCalledTimes(2) })
  expect(settled).toBe(false); expect(f.process.killed).toBe(true)
  f.range.resolve(true); await refused
  expect(f.process).toMatchObject({ outputDrained: true, quiescent: true, killed: true, exitCode: 0, signalCode: null })
})

it('rejects an abort during pending natural-range observation after direct zero exit and pipe drainage', async () => {
  const f = await fixture(); await f.spawned.promise
  const refused = expect(f.process.done).rejects.toThrow()
  let settled = false; void f.process.done.then(() => { settled = true }, () => { settled = true })
  f.exit.resolve({ exitCode: 0, signal: null }); f.stdout.end(); f.stderr.end()
  await vi.waitFor(() => { expect(f.waitForExit).toHaveBeenCalledOnce() })
  expect(f.terminate).not.toHaveBeenCalled(); expect(settled).toBe(false)
  f.lifetime.abort(new Error('Fixture cancellation after direct exit'))
  expect(f.terminate).toHaveBeenCalled()
  f.range.resolve(true); await refused
  expect(f.process).toMatchObject({ outputDrained: true, quiescent: true, killed: true, exitCode: 0, signalCode: null })
})

it('records diagnostic presence without retaining its body for a native persistence success claim', async () => {
  const f = await fixture(); await f.spawned.promise
  f.stderr.end('fixture persistence diagnostic'); f.stdout.end(); f.exit.resolve({ exitCode: 0, signal: null }); f.range.resolve(true)
  await f.process.done; expect(f.process.diagnosticOutput).toBe(true)
  expect(Object.values(f.process).filter(value => typeof value === 'string')).not.toContain('fixture persistence diagnostic')
})

it('rejects a prematurely closed native output pipe despite a zero exit status', async () => {
  const f = await fixture(); await f.spawned.promise
  const refused = expect(f.process.done).rejects.toThrow('drainage')
  f.stdout.destroy(); f.stderr.end(); f.exit.resolve({ exitCode: 0, signal: null }); f.range.resolve(true)
  await refused; expect(f.process.outputDrained).toBe(false); expect(f.process.quiescent).toBe(true)
})

it('rejects a forced termination even when the native process reports exit zero', async () => {
  const f = await fixture(); await f.spawned.promise
  const refused = expect(f.process.done).rejects.toThrow()
  f.process.kill('SIGTERM'); f.stdout.end(); f.stderr.end(); f.range.resolve(true)
  await refused; expect(f.process.killed).toBe(true); expect(f.process.quiescent).toBe(true)
})
