// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSharedGroupPendingQueue } from '../src/client/pending-group-queue.ts'

type LockCallback<T> = () => Promise<T>

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
const lockTails = new Map<string, Promise<void>>()
const lockRequest = async <T>(name: string, callback: LockCallback<T>): Promise<T> => {
  const previous = lockTails.get(name) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  lockTails.set(name, current)
  await previous
  try {
    return await callback()
  } finally {
    release?.()
    if (lockTails.get(name) === current) lockTails.delete(name)
  }
}

beforeAll(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: lockRequest } })
})
beforeEach(() => {
  localStorage.clear()
  lockTails.clear()
})
afterAll(() => {
  if (originalLocksDescriptor === undefined) Reflect.deleteProperty(navigator, 'locks')
  else Object.defineProperty(navigator, 'locks', originalLocksDescriptor)
})

describe('shared-group browser retry queue', () => {
  it('keeps concurrent operation records and reuses one id for the same operation', async () => {
    const firstTab = createSharedGroupPendingQueue('principal-alpha')
    const secondTab = createSharedGroupPendingQueue('principal-alpha')
    expect(firstTab.durable).toBe(true)

    const [first, second] = await Promise.all([
      firstTab.reserveCreation('launch-room', 'Launch room', ['bot-chief', 'bot-analyst']),
      secondTab.reserveCreation('launch-room', 'Launch room', ['bot-analyst', 'bot-chief']),
    ])
    expect(first.id).toBe(second.id)
    expect([first.recovered, second.recovered].sort()).toEqual([false, true])

    await Promise.all([
      firstTab.reserveCreation('research-room', 'Research room', ['bot-chief', 'bot-analyst']),
      secondTab.reserveCreation('writing-room', 'Writing room', ['bot-chief', 'bot-analyst']),
    ])
    const records = await firstTab.listCreations()
    expect(records.map(record => record.name).sort()).toEqual(['Launch room', 'Research room', 'Writing room'])
  })

  it('partitions retry records by server-issued principal scope and supports explicit discard', async () => {
    const alpha = createSharedGroupPendingQueue('principal-alpha')
    const beta = createSharedGroupPendingQueue('principal-beta')
    const reservation = await alpha.reserveCreation('same-operation', 'Alpha room', ['bot-chief', 'bot-analyst'])
    await beta.reserveCreation('same-operation', 'Beta room', ['bot-chief', 'bot-analyst'])

    expect((await alpha.listCreations()).map(record => record.name)).toEqual(['Alpha room'])
    expect((await beta.listCreations()).map(record => record.name)).toEqual(['Beta room'])

    await alpha.removeCreation(reservation.operationHash, reservation.id)
    await expect(alpha.listCreations()).resolves.toEqual([])
    await expect(beta.listCreations()).resolves.toHaveLength(1)
  })

  it('expires interrupted operations instead of retaining message text indefinitely', async () => {
    const queue = createSharedGroupPendingQueue('principal-expiry')
    const first = await queue.reserveMessage('message-key', 'bot-group-room', 'private draft')
    vi.useFakeTimers({ now: Date.now() + 24 * 60 * 60 * 1_000 + 1 })
    try {
      const second = await queue.reserveMessage('message-key', 'bot-group-room', 'private draft')
      expect(second.recovered).toBe(false)
      expect(second.id).not.toBe(first.id)
    } finally {
      vi.useRealTimers()
    }
  })
})
