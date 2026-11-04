// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSharedGroupPendingQueue,
  SHARED_GROUP_PENDING_QUEUE_MAX_RECORDS,
  SharedGroupPendingQueueFullError,
} from '../src/client/pending-group-queue.ts'

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

  it('keeps the legacy operation lock while coordinating through the catalog lock', async () => {
    const requests: string[] = []
    const originalRequest = navigator.locks.request
    vi.spyOn(navigator.locks, 'request').mockImplementation((name, callback) => {
      requests.push(name)
      return originalRequest.call(navigator.locks, name, callback)
    })
    try {
      const queue = createSharedGroupPendingQueue('principal-lock-compatibility')
      const reservation = await queue.reserveCreation('lock-operation', 'Lock room', ['bot-chief', 'bot-analyst'])
      const prefix = 'yharness.client-ui-bots.shared-group-pending-lock.principal-lock-compatibility'
      expect(requests).toEqual([
        `${prefix}.catalog`,
        `${prefix}.creation.${reservation.operationHash}`,
      ])
    } finally {
      vi.restoreAllMocks()
    }
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
      expect(second.recovered).toBe(true)
      expect(second.expired).toBe(true)
      expect(second.id).toBe(first.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists pending messages and keeps an expired tombstone id for reconciliation', async () => {
    const queue = createSharedGroupPendingQueue('principal-message-recovery')
    const first = await queue.reserveMessage('message-key', 'bot-group-room', 'recover this draft')
    await expect(queue.listMessages()).resolves.toMatchObject([{
      id: first.id,
      groupId: 'bot-group-room',
      text: 'recover this draft',
      expired: false,
    }])

    vi.useFakeTimers({ now: Date.now() + 24 * 60 * 60 * 1_000 + 1 })
    try {
      const expired = await queue.listMessages()
      expect(expired).toMatchObject([{ id: first.id, groupId: 'bot-group-room', expired: true }])
      expect(expired[0]).not.toHaveProperty('text')
      const retry = await queue.reserveMessage('message-key', 'bot-group-room', 'recover this draft')
      expect(retry.id).toBe(first.id)
      expect(retry.recovered).toBe(true)
      expect(retry.expired).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses new records at the safe quota without evicting tombstones', async () => {
    const queue = createSharedGroupPendingQueue('principal-quota')
    const first = await queue.reserveMessage('message-key-0', 'bot-group-room', 'message 0')
    vi.useFakeTimers({ now: Date.now() + 24 * 60 * 60 * 1_000 + 1 })
    try {
      await queue.listMessages()
      for (let index = 1; index < SHARED_GROUP_PENDING_QUEUE_MAX_RECORDS; index += 1) {
        await queue.reserveMessage(`message-key-${index}`, 'bot-group-room', `message ${index}`)
      }

      await expect(queue.reserveMessage('message-over-quota', 'bot-group-room', 'one more')).rejects.toBeInstanceOf(SharedGroupPendingQueueFullError)
      const records = await queue.listMessages()
      expect(records).toHaveLength(SHARED_GROUP_PENDING_QUEUE_MAX_RECORDS)
      expect(records.find(record => record.id === first.id)?.expired).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let another tab prune a freshly recreated record', async () => {
    const firstTab = createSharedGroupPendingQueue('principal-prune-race')
    const secondTab = createSharedGroupPendingQueue('principal-prune-race')
    const original = await secondTab.reserveMessage('old-message', 'bot-group-room', 'old draft')
    const targetKey = `yharness.client-ui-bots.shared-group-pending.principal-prune-race.message.${original.operationHash}`

    vi.useFakeTimers({ now: Date.now() + 24 * 60 * 60 * 1_000 + 1 })
    try {
      await firstTab.listMessages()
      const originalGetItem = Storage.prototype.getItem
      let recreated = false
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        const raw = originalGetItem.call(this, key)
        if (!recreated && key === targetKey && raw !== null) {
          recreated = true
          const oldRecord = JSON.parse(raw) as Record<string, unknown>
          localStorage.setItem(key, JSON.stringify({
            ...oldRecord,
            status: 'pending',
            text: 'fresh draft from second tab',
            createdAt: Date.now(),
            expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
          }))
          return raw
        }
        return raw
      })

      await firstTab.reserveMessage('different-message', 'bot-group-room', 'different draft')
      expect(recreated).toBe(true)
      const records = await secondTab.listMessages()
      expect(records).toEqual(expect.arrayContaining([expect.objectContaining({
        id: original.id,
        text: 'fresh draft from second tab',
        expired: false,
      })]))
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })
})
