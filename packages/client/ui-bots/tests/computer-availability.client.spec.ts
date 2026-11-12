import { describe, expect, it, vi } from 'vitest'
import type { ComputerClient, ComputerStatus } from '../src/client/computer-client.ts'
import { createComputerAvailability } from '../src/client/computer-availability.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function client(status: ComputerClient['status']): ComputerClient {
  return {
    status,
    frame: vi.fn(),
    takeControl: vi.fn(),
    releaseControl: vi.fn(),
    input: vi.fn(),
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Computer availability source', () => {
  it('refreshes the legacy route and maps macOS, VPS and unavailable states', async () => {
    const status = vi.fn<ComputerClient['status']>()
      .mockResolvedValueOnce({
        available: true,
        kind: 'mac',
        computer: { id: 'mac-computer', location: 'mac', permissionScope: 'workspace' },
      })
      .mockResolvedValueOnce({
        available: true,
        kind: 'vps',
        computer: { id: 'bot-session', location: 'vps', permissionScope: 'bot' },
      })
      .mockResolvedValueOnce({ available: false })
    const availability = createComputerAvailability(client(status))

    availability.refresh()
    await settle()
    expect(status).toHaveBeenNthCalledWith(1, expect.any(AbortSignal), undefined)
    expect(availability.source.getSnapshot()).toBe('mac')
    expect(availability.identity.getSnapshot()).toEqual({ id: 'mac-computer', location: 'mac', permissionScope: 'workspace' })

    availability.refresh('bot-session')
    await settle()
    expect(status).toHaveBeenNthCalledWith(2, expect.any(AbortSignal), 'bot-session')
    expect(availability.source.getSnapshot()).toBe('available')
    expect(availability.identity.getSnapshot()).toEqual({ id: 'bot-session', location: 'vps', permissionScope: 'bot' })

    availability.refresh('bot-session')
    await settle()
    expect(availability.source.getSnapshot()).toBe('unavailable')
    expect(availability.identity.getSnapshot()).toBeUndefined()
    availability.dispose()
  })

  it('keeps the latest Bot status when an earlier selection resolves late', async () => {
    const first = deferred<ComputerStatus>()
    const second = deferred<ComputerStatus>()
    const status = vi.fn<ComputerClient['status']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const availability = createComputerAvailability(client(status))

    availability.refresh('bot-first')
    const firstSignal = status.mock.calls[0]?.[0]
    availability.refresh('bot-second')
    const secondSignal = status.mock.calls[1]?.[0]
    expect(firstSignal?.aborted).toBe(true)
    expect(secondSignal?.aborted).toBe(false)
    expect(availability.source.getSnapshot()).toBe('checking')
    expect(availability.identity.getSnapshot()).toBeUndefined()

    second.resolve({ available: true, kind: 'vps', computer: { id: 'bot-second', location: 'vps', permissionScope: 'bot' } })
    await settle()
    expect(availability.source.getSnapshot()).toBe('available')
    expect(availability.identity.getSnapshot()).toEqual({ id: 'bot-second', location: 'vps', permissionScope: 'bot' })

    first.resolve({ available: true, kind: 'mac', computer: { id: 'bot-first', location: 'mac', permissionScope: 'workspace' } })
    await settle()
    expect(availability.source.getSnapshot()).toBe('available')
    expect(availability.identity.getSnapshot()).toEqual({ id: 'bot-second', location: 'vps', permissionScope: 'bot' })
    availability.dispose()
  })

  it('marks a current non-abort failure unavailable and ignores abort failures', async () => {
    const failure = vi.fn<ComputerClient['status']>().mockRejectedValueOnce(new Error('status unavailable'))
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const availability = createComputerAvailability(client(failure))

    availability.refresh('bot-failure')
    await settle()
    expect(availability.source.getSnapshot()).toBe('unavailable')
    expect(availability.identity.getSnapshot()).toBeUndefined()

    availability.refresh('bot-abort')
    await settle()
    expect(availability.source.getSnapshot()).toBe('checking')
    expect(availability.identity.getSnapshot()).toBeUndefined()
    availability.dispose()
  })

  it('prevents a disposed status request from publishing a result or failure', async () => {
    const pending = deferred<ComputerStatus>()
    const status = vi.fn<ComputerClient['status']>().mockReturnValue(pending.promise)
    const availability = createComputerAvailability(client(status))

    availability.refresh('bot-disposed')
    const signal = status.mock.calls[0]?.[0]
    availability.dispose()
    expect(signal?.aborted).toBe(true)
    availability.dispose()
    availability.refresh('ignored')
    pending.resolve({ available: true, kind: 'vps', computer: { id: 'late', location: 'vps', permissionScope: 'bot' } })
    await settle()
    expect(availability.source.getSnapshot()).toBe('checking')
    expect(availability.identity.getSnapshot()).toBeUndefined()
  })

  it('ignores a disposed request rejection without changing the source', async () => {
    const pending = deferred<ComputerStatus>()
    const status = vi.fn<ComputerClient['status']>().mockReturnValue(pending.promise)
    const availability = createComputerAvailability(client(status))

    availability.refresh('bot-disposed-error')
    availability.dispose()
    pending.reject(new Error('late status failure'))
    await settle()
    expect(availability.source.getSnapshot()).toBe('checking')
    expect(availability.identity.getSnapshot()).toBeUndefined()
  })
})
