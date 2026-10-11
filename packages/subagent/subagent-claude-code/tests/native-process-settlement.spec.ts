/** Process-owner settlement uses synthetic pipes and injected confinement/subprocess services. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SandboxProvider, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, { type SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { ClaudeRootProcess } from '../src/root-process.ts'

type Controls = {
  natural?: boolean
  missingDiagnostic?: boolean
  missingOutput?: boolean
  fullAccess?: boolean
  current?: boolean
  spawnFailure?: unknown
  preEnded?: boolean
  defaultCurrent?: boolean
}
async function fixture(controls: Controls = {}) {
  const ctx = new Context(); const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  const exit = Promise.withResolvers<SubprocessOutcome>(); const lifetime = new AbortController()
  const spawned = Promise.withResolvers<undefined>()
  const terminate = vi.fn(() => { exit.resolve({ exitCode: 0, signal: null }) })
  const waitForExit = vi.fn(async (_signal?: AbortSignal) => true)
  const confine = vi.fn(async (argv: readonly string[], _policy: SandboxPolicy) => ({ argv: [...argv], enforcement: 'full' as const,
    denialSignatures: [], runnerFailureRules: [] }))
  class Confine extends SandboxProvider { override confine = confine }
  class Processes extends SubprocessRuntime {
    override resolveExecutable(): never { throw new Error('unused executable discovery') }
    override terminalEnvironment(): never { throw new Error('unused terminal') }
    override spawnTerminal(): never { throw new Error('unused terminal') }
    override spawn() {
      if (controls.spawnFailure !== undefined) throw controls.spawnFailure
      spawned.resolve(undefined)
      return { stdin, stdout: controls.missingOutput ? undefined : stdout, stderr: controls.missingDiagnostic ? undefined : stderr,
        control: undefined, collected: {}, done: exit.promise, terminate, waitForExit }
    }
  }
  await ctx.plugin(Confine); await ctx.plugin(Processes)
  if (controls.preEnded) { stdout.resume(); stderr.resume(); stdout.end(); stderr.end()
    await new Promise<void>(resolve => setImmediate(resolve)) }
  const process = new ClaudeRootProcess(ctx, { command: '/fixture/claude', args: [], cwd: '/fixture', env: {}, signal: lifetime.signal },
    { mode: controls.fullAccess ? 'danger-full-access' : 'read-only', workspaceRoot: '/fixture' }, 5, lifetime.signal,
    controls.defaultCurrent ? undefined : () => controls.current !== false, { lineBytes: 16, lifetimeBytes: 32 }, controls.natural)
  process.stdout.resume()
  onTestFinished(async () => {
    process.kill('SIGTERM'); stdout.end(); stderr.end(); exit.resolve({ exitCode: 0, signal: null })
    await Promise.allSettled([process.done]); stdin.end(); await ctx.fiber.dispose()
  })
  return { process, stdin, stdout, stderr, exit, lifetime, spawned, terminate, waitForExit, confine }
}

it('publishes exit and signal facts through removable and one-shot listeners', async () => {
  const f = await fixture(); await f.spawned.promise
  const exit = vi.fn(); const removed = vi.fn(); const once = vi.fn()
  f.process.on('exit', exit); f.process.on('exit', removed); f.process.off('exit', removed); f.process.once('exit', once)
  f.exit.resolve({ exitCode: 7, signal: 'SIGTERM' }); await f.process.done
  expect(exit).toHaveBeenCalledWith(7, 'SIGTERM'); expect(once).toHaveBeenCalledOnce(); expect(removed).not.toHaveBeenCalled()
  expect(f.process.exitCode).toBe(7); expect(f.process.signalCode).toBe('SIGTERM'); expect(f.process.kill('SIGTERM')).toBe(false)
})

it('rejects stale policy before asking the confinement service', async () => {
  const f = await fixture({ current: false }); await expect(f.process.done).rejects.toThrow('policy changed')
  expect(f.confine).not.toHaveBeenCalled(); expect(f.process.quiescent).toBe(true)
})

it('normalizes a non-Error subprocess failure only for its error event', async () => {
  const f = await fixture({ spawnFailure: 'external spawn refusal' }); const errors: Error[] = []
  f.process.on('error', (error: Error) => errors.push(error)); await expect(f.process.done).rejects.toBe('external spawn refusal')
  expect(errors[0]?.message).toBe('Claude root process failed.'); expect(f.process.quiescent).toBe(true)
})

it('skips confinement for an explicitly full-access process policy', async () => {
  const f = await fixture({ fullAccess: true }); await f.spawned.promise; f.exit.resolve({ exitCode: 0, signal: null })
  await f.process.done
  expect(f.confine).not.toHaveBeenCalled()
})

it('rejects an unavailable output or required diagnostic pipe while confirming teardown', async () => {
  for (const controls of [{ missingOutput: true }, { natural: true, missingDiagnostic: true }]) {
    const f = await fixture(controls); await expect(f.process.done).rejects.toThrow(/piped|diagnostic stream/)
    expect(f.terminate).toHaveBeenCalled(); expect(f.process.quiescent).toBe(true)
  }
})

it.each(['stdout', 'stderr'] as const)('rejects an errored %s pipe despite successful direct exit', async (pipe) => {
  const f = await fixture({ natural: true }); await f.spawned.promise
  const settled = expect(f.process.done).rejects.toThrow('drainage')
  f[pipe].destroy(new Error('external pipe failure')); f[pipe === 'stdout' ? 'stderr' : 'stdout'].end(); f.exit.resolve({ exitCode: 0,
    signal: null })
  await settled; expect(f.process.quiescent).toBe(true)
})

it('rejects a premature diagnostic close and excessive diagnostic bytes', async () => {
  const f = await fixture({ natural: true }); await f.spawned.promise
  const closed = expect(f.process.done).rejects.toThrow('drainage')
  f.stderr.destroy(); f.stdout.end(); f.exit.resolve({ exitCode: 0, signal: null }); await closed
  const g = await fixture({ natural: true }); await g.spawned.promise
  const overflow = expect(g.process.done).rejects.toThrow()
  g.stderr.write(Buffer.alloc(33)); await overflow
  expect(g.process.diagnosticOutput).toBe(true); expect(g.terminate).toHaveBeenCalled()
})

it('counts complete stream lifetime across bounded lines and both directions', async () => {
  const f = await fixture(); await f.spawned.promise
  f.process.stdin.write(Buffer.from('a\nb\nc\n')); f.stdout.write(Buffer.from('d\ne\nf\n'))
  f.stdout.write(Buffer.from('g\n'.repeat(12)))
  await expect(f.process.done).rejects.toThrow(); expect(f.terminate).toHaveBeenCalled()
})

it('rejects a natural exit with nonzero status or signal independently of pipe drainage', async () => {
  for (const outcome of [{ exitCode: 1, signal: null }, { exitCode: 0, signal: 'SIGTERM' as const }, { exitCode: null,
    signal: 'SIGTERM' as const }]) {
    const f = await fixture({ natural: true }); await f.spawned.promise
    f.stdout.end(); f.stderr.end(); f.exit.resolve(outcome)
    await expect(f.process.done).rejects.toThrow('did not exit naturally'); expect(f.process.quiescent).toBe(true)
    expect(f.process.exitCode).toBe(outcome.exitCode)
  }
})

it('retains forced settlement when the first managed-range observation throws', async () => {
  const f = await fixture({ natural: true }); await f.spawned.promise
  f.waitForExit.mockRejectedValueOnce(new Error('external inspection failed'))
  f.stdout.end(); f.stderr.end(); f.exit.resolve({ exitCode: 0, signal: null })
  await expect(f.process.done).rejects.toThrow('required termination')
  expect(f.waitForExit).toHaveBeenCalledTimes(2); expect(f.process.killed).toBe(true); expect(f.process.quiescent).toBe(true)
})


it('settles already-drained pipes and the default current-policy predicate', async () => {
  const f = await fixture({ natural: true, preEnded: true, defaultCurrent: true }); await f.spawned.promise
  f.exit.resolve({ exitCode: 0, signal: null }); await f.process.done
  expect(f.process.outputDrained).toBe(true); expect(f.process.quiescent).toBe(true); expect(f.process.kill('SIGTERM')).toBe(false)
})
