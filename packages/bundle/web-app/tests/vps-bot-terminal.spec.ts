import { Readable } from 'node:stream'
import type { SubprocessOutcome, SubprocessTerminalHandle, SubprocessTerminalSignal } from '@yharness/subprocess'
import { describe, expect, it, vi } from 'vitest'
import { scopedBotTerminal } from '../src/vps-bot-terminal.ts'

const outcome: SubprocessOutcome = { exitCode: 0, signal: null }

function terminalFixture(done: Promise<SubprocessOutcome>) {
  const write = vi.fn(async (_data: string) => {})
  const resize = vi.fn(async (_cols: number, _rows: number) => {})
  const inspectActivity = vi.fn(async () => ({ state: 'busy' as const, revision: 3 }))
  const inspectForeground = vi.fn(async () => ({ processGroupId: 42, inputWaiting: false }))
  const signalForeground = vi.fn(async (_signal: SubprocessTerminalSignal) => 42)
  const terminate = vi.fn(async () => {})
  const host: SubprocessTerminalHandle = {
    pid: 42,
    output: Readable.from(['fixture']),
    done,
    write,
    resize,
    inspectActivity,
    inspectForeground,
    signalForeground,
    terminate,
  }
  return { host, write, resize, inspectActivity, inspectForeground, signalForeground, terminate }
}

describe('scoped Bot terminal', () => {
  it('forwards terminal operations and waits for both owners to close', async () => {
    const process = Promise.withResolvers<SubprocessOutcome>()
    const fixture = terminalFixture(process.promise)
    const stop = vi.fn(async () => {})
    const terminal = scopedBotTerminal(fixture.host, stop)

    expect(terminal.pid).toBe(fixture.host.pid)
    expect(terminal.output).toBe(fixture.host.output)
    await terminal.write('input')
    await terminal.resize(80, 24)
    await expect(terminal.inspectActivity()).resolves.toEqual({ state: 'busy', revision: 3 })
    await expect(terminal.inspectForeground()).resolves.toBeUndefined()
    await expect(terminal.signalForeground('SIGINT')).rejects.toThrow('foreground is unavailable')
    expect(fixture.write).toHaveBeenCalledWith('input')
    expect(fixture.resize).toHaveBeenCalledWith(80, 24)
    expect(fixture.inspectActivity).toHaveBeenCalledOnce()
    expect(fixture.inspectForeground).not.toHaveBeenCalled()
    expect(fixture.signalForeground).not.toHaveBeenCalled()

    const closing = terminal.terminate()
    expect(terminal.terminate()).toBe(closing)
    process.resolve(outcome)
    await expect(terminal.done).resolves.toBe(outcome)
    await expect(closing).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
    expect(fixture.terminate).toHaveBeenCalledOnce()
  })

  it('retries cleanup after a terminal exits when both owners fail to close', async () => {
    const stopFailure = new Error('container stop failed')
    const terminalFailure = new Error('host terminal failed')
    const fixture = terminalFixture(Promise.resolve(outcome))
    fixture.terminate.mockRejectedValueOnce(terminalFailure)
    const stop = vi.fn(async () => {})
    stop.mockRejectedValueOnce(stopFailure)
    const terminal = scopedBotTerminal(fixture.host, stop)

    const failure = await terminal.done.then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate cleanup failure')
    expect(failure.errors).toEqual([stopFailure, terminalFailure])
    expect(stop).toHaveBeenCalledOnce()
    expect(fixture.terminate).toHaveBeenCalledOnce()

    await expect(terminal.terminate()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(fixture.terminate).toHaveBeenCalledTimes(2)
  })

  it('preserves a terminal failure after successful cleanup', async () => {
    const processFailure = new Error('terminal allocation cancelled')
    const fixture = terminalFixture(Promise.reject(processFailure))
    const stop = vi.fn(async () => {})
    const terminal = scopedBotTerminal(fixture.host, stop)

    await expect(terminal.done).rejects.toBe(processFailure)
    expect(stop).toHaveBeenCalledOnce()
    expect(fixture.terminate).toHaveBeenCalledOnce()
  })

  it('reports both a terminal failure and cleanup failure', async () => {
    const processFailure = new Error('terminal transport failed')
    const cleanupFailure = new Error('container stop failed')
    const fixture = terminalFixture(Promise.reject(processFailure))
    const stop = vi.fn(async () => { throw cleanupFailure })
    const terminal = scopedBotTerminal(fixture.host, stop)

    const failure = await terminal.done.then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected terminal and cleanup failure')
    expect(failure.errors[0]).toBe(processFailure)
    expect(failure.errors[1]).toBeInstanceOf(AggregateError)
    expect((failure.errors[1] as AggregateError).errors).toEqual([cleanupFailure])
  })
})
