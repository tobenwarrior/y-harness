import { afterEach, describe, expect, it, vi } from 'vitest'
import { MacComputerBridge, type MacComputerTransport } from '../src/mac-computer.ts'

interface SendCallback {
  (error: Error | null): void
}

class FixtureTransport implements MacComputerTransport {
  connected = true
  readonly sent: object[] = []
  private readonly callbacks: SendCallback[] = []
  private readonly requestIds: number[] = []
  private nextRequestId = 0
  private listener: ((message: unknown) => void) | undefined
  private throwOnSend: { readonly value: unknown } | undefined
  private throwAfterCallback: { readonly value: unknown } | undefined

  on(event: 'message', listener: (message: unknown) => void): void {
    if (event !== 'message') throw new Error('unexpected FixtureTransport event')
    this.listener = listener
  }

  off(event: 'message', listener: (message: unknown) => void): void {
    if (event !== 'message') throw new Error('unexpected FixtureTransport event')
    if (this.listener === listener) this.listener = undefined
  }

  send(message: object, callback: SendCallback): void {
    if (this.throwOnSend !== undefined) {
      const thrown = this.throwOnSend.value
      this.throwOnSend = undefined
      throw thrown
    }
    this.sent.push(message)
    this.callbacks.push(callback)
    this.requestIds.push(++this.nextRequestId)
    if (this.throwAfterCallback !== undefined) {
      const thrown = this.throwAfterCallback.value
      this.throwAfterCallback = undefined
      callback(new Error('callback completed first'))
      throw thrown
    }
  }

  throwNext(value: unknown): void {
    this.throwOnSend = { value }
  }

  throwNextAfterCallback(value: unknown): void {
    this.throwAfterCallback = { value }
  }

  callback(error: Error | null): void {
    const callback = this.callbacks.at(-1)
    if (callback === undefined) throw new Error('FixtureTransport callback missing')
    callback(error)
  }

  reply(value: unknown): void {
    const id = this.requestIds.at(-1)
    if (id === undefined) throw new Error('FixtureTransport request missing')
    this.deliver({ type: 'mac-computer-response', id, value })
  }

  replyWithoutValue(): void {
    const id = this.requestIds.at(-1)
    if (id === undefined) throw new Error('FixtureTransport request missing')
    this.deliver({ type: 'mac-computer-response', id })
  }

  deliver(message: unknown): void {
    this.listener?.(message)
  }

  hasListener(): boolean {
    return this.listener !== undefined
  }
}

function fixture(): { readonly bridge: MacComputerBridge; readonly transport: FixtureTransport } {
  const transport = new FixtureTransport()
  return { bridge: new MacComputerBridge(transport), transport }
}

async function expectInvalidFrame(value: unknown): Promise<void> {
  const { bridge, transport } = fixture()
  try {
    const pending = bridge.observe('fixture-session', new AbortController().signal)
    transport.reply(value)
    await expect(pending).rejects.toThrow('Mac Computer returned an invalid screenshot.')
  } finally {
    bridge.dispose()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Mac Computer desktop bridge', () => {
  it('sends requests, accepts replies, and ignores unrelated messages', async () => {
    const { bridge, transport } = fixture()
    try {
      const first = bridge.request('fixture-session', { kind: 'click', x: 2 }, new AbortController().signal)
      expect(transport.sent).toEqual([{
        type: 'mac-computer-request',
        id: 1,
        request: { sessionId: 'fixture-session', action: { kind: 'click', x: 2 } },
      }])
      for (const message of [
        1,
        null,
        {},
        { type: 'other', id: 1 },
        { type: 'mac-computer-response' },
        { type: 'mac-computer-response', id: '1' },
        { type: 'mac-computer-response', id: 999 },
      ]) transport.deliver(message)
      transport.callback(null)
      transport.reply({ accepted: true })
      await expect(first).resolves.toEqual({ accepted: true })

      const second = bridge.request('fixture-session', { kind: 'observe' }, new AbortController().signal)
      transport.replyWithoutValue()
      await expect(second).resolves.toBeUndefined()
      transport.callback(new Error('late callback'))

      const third = bridge.request('fixture-session', { kind: 'observe' }, new AbortController().signal)
      transport.deliver({ type: 'mac-computer-response', id: 3, error: 42, value: { accepted: 'non-string error' } })
      await expect(third).resolves.toEqual({ accepted: 'non-string error' })

      const fourth = bridge.request('fixture-session', { kind: 'observe' }, new AbortController().signal)
      transport.deliver({ type: 'mac-computer-response', id: 4, error: 'denied' })
      await expect(fourth).rejects.toThrow('denied')
    } finally {
      bridge.dispose()
    }
  })

  it('validates observed frames at the wire boundary', async () => {
    await expectInvalidFrame(undefined)
    await expectInvalidFrame(null)
    await expectInvalidFrame({})
    await expectInvalidFrame({ jpeg: 1 })
    await expectInvalidFrame({ jpeg: 'x'.repeat(8_000_001), width: 1, height: 1 })
    await expectInvalidFrame({ jpeg: 'fixture' })
    await expectInvalidFrame({ jpeg: 'fixture', width: 1.5, height: 1 })
    await expectInvalidFrame({ jpeg: 'fixture', width: 1 })
    await expectInvalidFrame({ jpeg: 'fixture', width: 1, height: 1.5 })
    await expectInvalidFrame({ jpeg: 'fixture', width: '1', height: 1 })
    await expectInvalidFrame({ jpeg: 'fixture', width: 0, height: 1 })
    await expectInvalidFrame({ jpeg: 'fixture', width: 1, height: '1' })
    await expectInvalidFrame({ jpeg: 'fixture', width: 1, height: 0 })

    const { bridge, transport } = fixture()
    try {
      const pending = bridge.observe('fixture-session', new AbortController().signal)
      transport.reply({ jpeg: 'fixture-jpeg', width: 1280, height: 800 })
      await expect(pending).resolves.toEqual({ jpeg: 'fixture-jpeg', width: 1280, height: 800 })
    } finally {
      bridge.dispose()
    }
  })

  it('handles unavailable transports and send failures', async () => {
    const first = fixture()
    first.transport.connected = false
    expect(() => first.bridge.request('fixture-session', {}, new AbortController().signal)).toThrow('unavailable')
    first.transport.connected = true
    first.bridge.dispose()
    expect(() => first.bridge.request('fixture-session', {}, new AbortController().signal)).toThrow('unavailable')

    const withoutSend = new MacComputerBridge({ connected: true, on: vi.fn(), off: vi.fn() })
    try {
      expect(() => withoutSend.request('fixture-session', {}, new AbortController().signal)).toThrow('unavailable')
    } finally {
      withoutSend.dispose()
    }

    const second = fixture()
    try {
      second.transport.throwNext(new Error('send exception'))
      await expect(second.bridge.request('fixture-session', {}, new AbortController().signal)).rejects.toThrow('send exception')
      second.transport.throwNext('non-error send exception')
      await expect(second.bridge.request('fixture-session', {}, new AbortController().signal)).rejects.toThrow('non-error send exception')
      second.transport.throwNextAfterCallback(new Error('after callback'))
      await expect(second.bridge.request('fixture-session', {}, new AbortController().signal)).rejects.toThrow('unavailable')
    } finally {
      second.bridge.dispose()
    }
  })

  it('cancels active requests and rejects a deadline', async () => {
    const { bridge, transport } = fixture()
    try {
      const errorController = new AbortController()
      const cancelled = bridge.request('fixture-session', {}, errorController.signal)
      errorController.abort(new Error('fixture cancellation'))
      await expect(cancelled).rejects.toThrow('fixture cancellation')

      const stringController = new AbortController()
      const stringCancelled = bridge.request('fixture-session', {}, stringController.signal)
      stringController.abort('string cancellation')
      await expect(stringCancelled).rejects.toThrow('string cancellation')
      transport.deliver({ type: 'mac-computer-response', id: 2, value: 'late' })

      vi.useFakeTimers()
      const timed = bridge.request('fixture-session', {}, new AbortController().signal)
      const timedRejection = expect(timed).rejects.toThrow('Mac Computer did not respond.')
      await vi.advanceTimersByTimeAsync(5_999)
      await vi.advanceTimersByTimeAsync(1)
      await timedRejection
      transport.deliver({ type: 'mac-computer-response', id: 3, value: 'late' })
    } finally {
      bridge.dispose()
    }
  })

  it('disposes the listener and rejects outstanding work', async () => {
    const { bridge, transport } = fixture()
    const pending = bridge.request('fixture-session', {}, new AbortController().signal)
    bridge.dispose()
    await expect(pending).rejects.toThrow('Mac Computer is unavailable.')
    expect(transport.hasListener()).toBe(false)
    transport.deliver({ type: 'mac-computer-response', id: 1, value: 'late' })
    bridge.dispose()
    expect(() => bridge.request('fixture-session', {}, new AbortController().signal)).toThrow('unavailable')
  })

  it('rejects a signal that is already aborted before dispatch', () => {
    const { bridge } = fixture()
    try {
      const controller = new AbortController()
      controller.abort(new Error('already cancelled'))
      expect(() => bridge.request('fixture-session', {}, controller.signal)).toThrow('already cancelled')
    } finally {
      bridge.dispose()
    }
  })
})
