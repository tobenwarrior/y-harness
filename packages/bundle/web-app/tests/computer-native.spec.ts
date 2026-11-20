import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FixtureChild extends EventEmitter {
  readonly stdin: EventEmitter & { readonly end: (value?: string) => void }
  readonly kill: (signal: NodeJS.Signals) => void
  readonly close: (code: number | null) => void
  readonly error: (error: Error) => void
}

function child(kill: (signal: NodeJS.Signals) => void = () => {}): FixtureChild {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  const process = new EventEmitter()
  return Object.assign(process, {
    stdin,
    kill,
    close: (code: number | null): void => { process.emit('close', code) },
    error: (error: Error): void => { process.emit('error', error) },
  })
}

async function host(spawn: (command: string, args: readonly string[], options: SpawnOptions) => FixtureChild) {
  vi.resetModules()
  vi.doMock('node:child_process', () => ({ spawn: vi.fn(spawn) }))
  return import('../src/computer.ts')
}

async function hostWithCaptureFiles(mkdtemp: () => Promise<string> = async () => '/tmp/computer-capture-fixture') {
  vi.resetModules()
  vi.doMock('node:fs/promises', () => ({
    chmod: vi.fn(async () => undefined),
    mkdtemp: vi.fn(mkdtemp),
    readFile: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    rm: vi.fn(async () => { throw new Error('cleanup fixture detail') }),
  }))
  return import('../src/computer.ts')
}

const config = { display: ':fixture', authorityPath: '/dev/null' }

afterEach(() => {
  vi.doUnmock('node:child_process')
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
})

describe('Computer native child-process runner', () => {
  it('maps spawn errors, nonzero exits, and successful commands', async () => {
    const spawnError = await host(() => { throw new Error('spawn fixture detail') })
    const failed = new spawnError.ComputerHost(config)
    await expect(failed.botAction({ kind: 'move', x: 1, y: 2 })).rejects.toMatchObject({ code: 'command-failed' })
    await failed.dispose()

    let process: FixtureChild | undefined
    const spawnExit = await host((_command, _args, _options) => {
      process = child()
      queueMicrotask(() => process?.close(17))
      return process
    })
    const exited = new spawnExit.ComputerHost(config)
    await expect(exited.botAction({ kind: 'move', x: 1, y: 2 })).rejects.toMatchObject({ code: 'command-failed' })
    await exited.dispose()

    const spawnSuccess = await host((_command, _args, _options) => {
      process = child()
      queueMicrotask(() => process?.close(0))
      return process
    })
    const succeeded = new spawnSuccess.ComputerHost(config)
    await expect(succeeded.botAction({ kind: 'move', x: 1, y: 2 })).resolves.toBeUndefined()
    await succeeded.dispose()
  })

  it('maps child error events and does not settle twice', async () => {
    let process: FixtureChild | undefined
    const module = await host((_command, _args, _options) => {
      process = child()
      queueMicrotask(() => {
        process?.error(new Error('child fixture detail'))
        process?.close(0)
      })
      return process
    })
    const fixture = new module.ComputerHost(config)
    await expect(fixture.botAction({ kind: 'move', x: 1, y: 2 })).rejects.toMatchObject({ code: 'command-failed' })
    await fixture.dispose()
  })

  it('rejects a signal that aborts while the native command is being admitted', async () => {
    const module = await host((_command, _args, _options) => child())
    let reads = 0
    const signal = {
      get aborted() {
        reads++
        return reads >= 3
      },
    } as never as AbortSignal
    const fixture = new module.ComputerHost(config)
    await expect(fixture.botAction({ kind: 'move', x: 1, y: 2 }, signal)).rejects.toMatchObject({ code: 'aborted' })
    expect(reads).toBe(3)
    await fixture.dispose()
  })

  it('maps command deadlines and cooperative aborts while tolerating kill failures', async () => {
    vi.useFakeTimers()
    try {
      let process: FixtureChild | undefined
      const timed = await host((_command, _args, _options) => {
        process = child(() => { throw new Error('kill fixture detail') })
        return process
      })
      const timedHost = new timed.ComputerHost(config)
      const pendingTimeout = timedHost.botAction({ kind: 'move', x: 1, y: 2 })
      await vi.runOnlyPendingTimersAsync()
      if (process !== undefined) process.close(null)
      await expect(pendingTimeout).rejects.toMatchObject({ code: 'command-timeout' })
      await timedHost.dispose()

      const abortedProcess = child(() => { throw new Error('kill fixture detail') })
      const abortedModule = await host(() => abortedProcess)
      const abortedHost = new abortedModule.ComputerHost(config)
      const controller = new AbortController()
      const pendingAbort = abortedHost.botAction({ kind: 'move', x: 1, y: 2 }, controller.signal)
      await Promise.resolve()
      controller.abort()
      abortedProcess.close(null)
      await expect(pendingAbort).rejects.toMatchObject({ code: 'aborted' })
      await abortedHost.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pipes sign-in key and text input through stdin and observes stdin errors', async () => {
    let process: FixtureChild | undefined
    const module = await host((_command, args, _options) => {
      process = child()
      if (args[0] === '-') queueMicrotask(() => { process?.stdin.emit('error', new Error('stdin fixture detail')) })
      queueMicrotask(() => process?.close(0))
      return process
    })
    const fixture = new module.ComputerHost(config)
    const waiting = fixture.requestSignIn(new AbortController().signal)
    await vi.waitFor(() => { expect(fixture.signInRequest()).toBeDefined() })
    const request = fixture.signInRequest()
    if (request === undefined) throw new Error('sign-in request missing')
    await fixture.answerSignIn(request.id, 'take', '11111111-1111-4111-8111-111111111111')
    await fixture.input('11111111-1111-4111-8111-111111111111', { kind: 'key', key: 'ctrl+$' })
    await fixture.input('11111111-1111-4111-8111-111111111111', { kind: 'text', text: 'fixture' })
    expect(process?.stdin.end).toHaveBeenCalled()
    await fixture.answerSignIn(request.id, 'complete', '11111111-1111-4111-8111-111111111111')
    await expect(waiting).resolves.toBe('completed')
    await fixture.dispose()
  })

  it('keeps a valid native capture when temporary-directory cleanup reports an error', async () => {
    const module = await hostWithCaptureFiles()
    const fixture = new module.ComputerHost(config, { run: async () => {} })
    await expect(fixture.observe()).resolves.toMatchObject({
      jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
    })
    await fixture.dispose()
  })

  it('maps temporary-directory creation failures without attempting cleanup', async () => {
    const module = await hostWithCaptureFiles(async () => { throw new Error('directory fixture detail') })
    const fixture = new module.ComputerHost(config, { run: async () => {} })
    await expect(fixture.observe()).rejects.toMatchObject({ code: 'capture-failed' })
    await fixture.dispose()
  })
})
