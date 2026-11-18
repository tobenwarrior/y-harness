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

const { spawn, observeExec } = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => Child>(),
  observeExec: vi.fn<(child: ChildProcess) => void>(),
}))
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

  closeWith(code: number | null): void {
    this.stdout.destroy()
    this.stderr.destroy()
    this.emit('close', code)
  }

  close(): void {
    this.closeWith(null)
  }
}

const session = 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('VPS provisioning processes', () => {
  it('returns desktop output and reports input failures through the command boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const argv = vi.spyOn(runtime, 'execArgv')
    try {
      argv.mockReturnValue([process.execPath, '-e', 'process.stdout.write("output")'])
      await expect(runtime.desktopCommand(session, ['/bin/echo'], new AbortController().signal)).resolves.toEqual(Buffer.from('output'))

      argv.mockReturnValue([process.execPath, '-e', 'process.exitCode = 1'])
      await expect(runtime.desktopCommand(session, ['/bin/echo'], new AbortController().signal)).rejects.toThrow()

      argv.mockReturnValue([process.execPath, '-e', 'process.exitCode = 1'])
      await expect(runtime.desktopCommand(session, ['/bin/echo'], new AbortController().signal, 'input'))
        .rejects.toThrow('input could not be sent')
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('contains a terminal stdin error without changing command completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const argv = vi.spyOn(runtime, 'execArgv').mockReturnValue([
      process.execPath, '-e', 'setTimeout(() => process.stdout.write("done"), 25)',
    ])
    observeExec.mockImplementationOnce((command) => {
      queueMicrotask(() => { command.stdin?.emit('error', new Error('fixture stdin closed')) })
    })
    try {
      await expect(runtime.desktopCommand(session, ['/bin/echo'], new AbortController().signal, 'input'))
        .resolves.toEqual(Buffer.from('done'))
      expect(argv).toHaveBeenCalledOnce()
    } finally {
      await runtime.dispose()
      observeExec.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('captures Podman output and returns its exit status through the process seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const child = new Child()
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.write('stdout')
        child.stderr.write('stderr')
        child.closeWith(2)
      })
      return child
    })
    try {
      await expect(runtime.ensure(session)).rejects.toThrow('container lookup failed')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a Podman start error and ignores its subsequent close event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const child = new Child()
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.emit('error', new Error('fixture spawn failed'))
        child.closeWith(0)
      })
      return child
    })
    try {
      await expect(runtime.ensure(session)).rejects.toThrow('Podman could not start')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a Podman child that closes without an exit status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const child = new Child()
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => { child.closeWith(null) })
      return child
    })
    try {
      await expect(runtime.ensure(session)).rejects.toThrow('without a status')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['stdout', 'stderr'] as const)('terminates a Podman child that exceeds the %s output limit', async (stream) => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const configuration = new AbortController()
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false }, {
      configurationSignal: configuration.signal,
    })
    const child = new Child()
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        const output = Buffer.alloc(64 * 1024 + 1, 'x')
        if (stream === 'stdout') child.stdout.write(output)
        else child.stderr.write(output)
        child.emit('error', new Error('fixture output failure'))
        child.stdout.emit('data', 'late stdout')
        child.stderr.emit('data', 'late stderr')
        configuration.abort(new Error('fixture configuration closed'))
        child.closeWith(null)
      })
      return child
    })
    try {
      await expect(runtime.ensure(session)).rejects.toThrow('output exceeded its limit')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('force-kills an aborted Podman child after its grace period', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const configuration = new AbortController()
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false }, {
      configurationSignal: configuration.signal,
    })
    const child = new Child()
    const spawned = Promise.withResolvers<undefined>()
    spawn.mockImplementationOnce(() => {
      spawned.resolve(undefined)
      queueMicrotask(() => { configuration.abort(new Error('fixture configuration closed')) })
      return child
    })
    try {
      const pending = runtime.ensure(session)
      await spawned.promise
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
      child.close()
      await expect(pending).rejects.toThrow('VPS Bot Computer scope is closed')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honors an already-aborted signal after the child is created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const configuration = new AbortController()
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false }, {
      configurationSignal: configuration.signal,
    })
    const child = new Child()
    spawn.mockImplementationOnce(() => {
      configuration.abort(new Error('fixture configuration closed'))
      queueMicrotask(() => { child.close() })
      return child
    })
    try {
      await expect(runtime.ensure(session)).rejects.toThrow('VPS Bot Computer scope is closed')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('times out a Podman child after its command deadline', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const child = new Child()
    const spawned = Promise.withResolvers<undefined>()
    spawn.mockImplementationOnce(() => {
      spawned.resolve(undefined)
      return child
    })
    try {
      const pending = runtime.ensure(session)
      await spawned.promise
      const timedOut = expect(pending).rejects.toThrow('Podman command timed out')
      await vi.advanceTimersByTimeAsync(120_000)
      await vi.advanceTimersByTimeAsync(2_000)
      child.close()
      await timedOut
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops unsafe inherited environment values from Podman', async () => {
    const previousHome = process.env.HOME
    const previousRuntime = process.env.XDG_RUNTIME_DIR
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const child = new Child()
    let observed: NodeJS.ProcessEnv | undefined
    process.env.HOME = 'unsafe\npath'
    process.env.XDG_RUNTIME_DIR = 'unsafe\npath'
    spawn.mockImplementationOnce((_command, _args, options) => {
      observed = options.env
      queueMicrotask(() => { child.closeWith(2) })
      return child
    })
    try {
      await expect(runtime.ensure(session)).rejects.toThrow('container lookup failed')
      expect(observed?.HOME).toBeUndefined()
      expect(observed?.XDG_RUNTIME_DIR).toBeUndefined()
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntime
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes a safe runtime directory through the scrubbed environment', async () => {
    const previousRuntime = process.env.XDG_RUNTIME_DIR
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture', { userService: false })
    const child = new Child()
    let observed: NodeJS.ProcessEnv | undefined
    process.env.XDG_RUNTIME_DIR = '/tmp/yharness-runtime-fixture'
    spawn.mockImplementationOnce((_command, _args, options) => {
      observed = options.env
      queueMicrotask(() => { child.closeWith(2) })
      return child
    })
    try {
      await expect(runtime.ensure(session)).rejects.toThrow('container lookup failed')
      expect(observed?.XDG_RUNTIME_DIR).toBe('/tmp/yharness-runtime-fixture')
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntime
      await rm(root, { recursive: true, force: true })
    }
  })

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
