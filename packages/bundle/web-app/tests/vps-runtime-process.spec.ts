import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
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

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn<() => Child>() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn,
}))

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
})
