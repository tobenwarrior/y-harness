import type { ChildProcess, ExecFileOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { VpsRuntime } from '../src/vps-runtime.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  if (process.platform !== 'win32') return actual
  const lstat = async (...args: Parameters<typeof actual.lstat>) => {
    const info = await actual.lstat(...args)
    if (typeof info.mode !== 'number') return info
    const privateMode = info.isDirectory() ? 0o700 : info.isFile() ? 0o600 : info.mode & 0o777
    Object.defineProperty(info, 'mode', { configurable: true, value: (info.mode & ~0o777) | privateMode })
    Object.defineProperty(info, 'uid', { configurable: true, value: typeof process.getuid === 'function' ? process.getuid() : 0 })
    return info
  }
  return { ...actual, lstat }
})

const { spawn, observeExec } = vi.hoisted(() => ({ spawn: vi.fn<() => Child>(), observeExec: vi.fn<(child: ChildProcess) => void>() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const exec = promisify(actual.execFile)
  const launch = (file: string, args: readonly string[], options: ExecFileOptions) => {
    const command = exec(file, args, options)
    observeExec(command.child)
    return command
  }
  return { ...actual, spawn, execFile: Object.assign(vi.fn(actual.execFile), { [promisify.custom]: launch }) }
})

class Child extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn<(signal: NodeJS.Signals) => boolean>().mockReturnValue(true)

  close(): void {
    this.stdout.destroy()
    this.stderr.destroy()
    this.emit('close', null)
  }
}

const session = 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('VPS provisioning processes', () => {
  it('cancels provisioning when the Web configuration closes and drains the child on disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const configuration = new AbortController()
    const runtime = new VpsRuntime(root, 'localhost/fixture', undefined, { configurationSignal: configuration.signal })
    const child = new Child()
    const spawned = Promise.withResolvers<undefined>()
    spawn.mockImplementationOnce(() => {
      spawned.resolve(undefined)
      return child
    })
    const preparing = runtime.ensure(session)
    const refused = expect(preparing).rejects.toThrow('VPS Bot Computer scope is closed')
    try {
      await spawned.promise
      configuration.abort(new Error('VPS Bot Computer scope is closed'))
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      let finished = false
      const closing = runtime.dispose().then(() => { finished = true })
      await Promise.resolve()
      expect(finished).toBe(false)
      child.close()
      await refused
      await closing
      expect(spawn).toHaveBeenCalledOnce()
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows the existing terminal group to stop after desktop requests are revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const configuration = new AbortController()
    const runtime = new VpsRuntime(root, 'localhost/fixture', undefined, { configurationSignal: configuration.signal })
    const argv = vi.spyOn(runtime, 'execArgv').mockReturnValue([process.execPath, '-e', ''])
    const scope = 'a'.repeat(32)
    try {
      const signal = new AbortController().signal
      const desktopRequest = runtime.desktopCommand(session, ['/bin/bash'], signal)
      const cancelled = expect(desktopRequest).rejects.toThrow('VPS Bot Computer scope is closed')
      configuration.abort(new Error('VPS Bot Computer scope is closed'))
      await cancelled
      await expect(runtime.desktopCommand(session, ['/bin/bash'], signal)).rejects.toThrow('VPS Bot Computer scope is closed')
      await runtime.stopTerminal(session, scope, 250)
      expect(argv).toHaveBeenCalledTimes(2)
      expect(argv.mock.calls[1]?.[0]).toBe(session)
      expect(argv.mock.calls[1]?.[1].slice(-3)).toEqual(['stop', scope, '250'])

      await runtime.dispose()
      await expect(runtime.stopTerminal(session, scope, 250)).rejects.toThrow('VPS Bot Computer scope is closed')
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  // Windows terminates the child without running its POSIX SIGTERM handler.
  it.skipIf(process.platform === 'win32')('waits for an aborted desktop command to close before releasing its runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-command-close-'))
    const termination = join(root, 'sigterm')
    const configuration = new AbortController()
    const runtime = new VpsRuntime(root, 'localhost/fixture', undefined, { configurationSignal: configuration.signal })
    const reason = new Error('VPS Bot Computer scope is closed')
    const ready = Promise.withResolvers<ChildProcess>()
    const closed = Promise.withResolvers<undefined>()
    let child: ChildProcess | undefined
    let childClosed = false
    let cleaning = false
    const reap = async (): Promise<void> => {
      cleaning = true
      if (child === undefined) return
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed.promise
    }
    onTestFinished(reap)
    observeExec.mockImplementationOnce((command) => {
      child = command
      command.once('close', () => {
        childClosed = true
        closed.resolve(undefined)
      })
      let output = ''
      command.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.includes('ready\n')) ready.resolve(command)
      })
      if (cleaning) command.kill('SIGKILL')
    })
    vi.spyOn(runtime, 'execArgv').mockReturnValue([process.execPath, '-e', String.raw`
      const { writeFileSync } = require('node:fs')
      process.once('SIGTERM', () => writeFileSync(process.argv[1], ''))
      process.stdin.resume()
      process.stdout.write('ready\n')
    `, termination])
    const beginUse = runtime.beginUse.bind(runtime)
    let leaseReleased = false
    vi.spyOn(runtime, 'beginUse').mockImplementation((sessionId) => {
      const release = beginUse(sessionId)
      return () => { leaseReleased = true; release() }
    })

    let commandSettled = false
    const command = runtime.desktopCommand(session, ['/bin/bash'], new AbortController().signal)
    const finished = Promise.allSettled([command]).then((result) => { commandSettled = true; return result })
    let disposed = false
    let disposal: Promise<void> | undefined
    try {
      const running = await Promise.race([ready.promise, finished.then(() => {
        throw new Error('The desktop command finished before reporting readiness.')
      })])
      configuration.abort(reason)
      disposal = runtime.dispose().then(() => { disposed = true })
      await expect.poll(() => existsSync(termination)).toBe(true)
      await setImmediate()
      const whileChildHeld = { childClosed, commandSettled, leaseReleased, disposed }
      running.stdin?.end()
      await closed.promise
      await expect(command).rejects.toBe(reason)
      await disposal
      expect(running.exitCode).toBe(0)
      expect(whileChildHeld).toEqual({ childClosed: false, commandSettled: false, leaseReleased: false, disposed: false })
    } finally {
      await reap()
      await finished
      await (disposal ?? runtime.dispose())
      observeExec.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })
})
