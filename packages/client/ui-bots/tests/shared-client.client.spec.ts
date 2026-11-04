import type { ClientConnectionRpc } from '@yharness/client-connection/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { broadcastSharedAuthChanged, createSharedBotsClient } from '../src/client/shared-client.ts'

type MessageListener = (event: { readonly data: unknown }) => void

class FakeBroadcastChannel {
  static readonly peers = new Set<FakeBroadcastChannel>()
  readonly listeners = new Set<MessageListener>()

  constructor(readonly name: string) {
    FakeBroadcastChannel.peers.add(this)
  }

  addEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.delete(listener)
  }

  postMessage(data: unknown): void {
    for (const peer of [...FakeBroadcastChannel.peers]) {
      if (peer === this || peer.name !== this.name) continue
      queueMicrotask(() => {
        for (const listener of [...peer.listeners]) listener({ data })
      })
    }
  }

  close(): void {
    FakeBroadcastChannel.peers.delete(this)
    this.listeners.clear()
  }
}

afterEach(() => {
  FakeBroadcastChannel.peers.clear()
})

describe('shared Bot client capabilities', () => {
  it('advertises isolated shared-group operations when the server route is available', () => {
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: true as const, value: {} })),
    }
    const client = createSharedBotsClient(rpc)

    expect(client.listGroups).toEqual(expect.any(Function))
    expect(client.createGroup).toEqual(expect.any(Function))
    expect(client.updateGroup).toEqual(expect.any(Function))
    expect(client.inspectGroup).toEqual(expect.any(Function))
    expect(client.sendGroupMessage).toEqual(expect.any(Function))
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('fails closed on malformed shared-group catalog data', async () => {
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: true as const, value: { groups: [{ id: 'bot-group-bad' }] } })),
    }
    const client = createSharedBotsClient(rpc)
    if (client.listGroups === undefined) throw new Error('shared group catalog is unavailable')
    await expect(client.listGroups()).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/invalid-response' },
    })
  })

  it('retains the group identity returned by a group-only enrollment', async () => {
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => ({
        ok: true as const,
        value: { principalId: 'principal-member', expiresAt: 2_000, groupId: 'bot-group-shared' },
      })),
    }
    const client = createSharedBotsClient(rpc)
    await expect(client.enroll('group-code')).resolves.toMatchObject({
      ok: true,
      value: { principalId: 'principal-member', groupId: 'bot-group-shared' },
    })
    expect(client.retryScope).toBe('principal-member')
  })

  it('rejects an enrollment response without a server-issued principal id', async () => {
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: true as const, value: { principalId: 'operator', expiresAt: 2_000 } })),
    }
    const client = createSharedBotsClient(rpc)
    await expect(client.enroll('bad-code')).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/invalid-response' },
    })
    expect(client.retryScope).toBeUndefined()
  })

  it('restores the authenticated principal scope after the browser reloads', async () => {
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => endpoint === 'bots/share/session'
        ? { ok: true as const, value: { principalId: 'principal-restored', expiresAt: 3_000 } }
        : { ok: false as const, error: { code: 'gateway/not-found', message: 'not found', details: {} } }),
    }
    const client = createSharedBotsClient(rpc)
    expect(client.retryScope).toBeUndefined()
    if (client.restoreRetryScope === undefined) throw new Error('retry scope restoration is unavailable')
    await expect(client.restoreRetryScope()).resolves.toMatchObject({
      ok: true,
      value: { principalId: 'principal-restored' },
    })
    expect(client.retryScope).toBe('principal-restored')
  })

  it('uses the host-only owner enrollment payload and stores its durable scope', async () => {
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint, payload) => {
        expect(endpoint).toBe('bots/share/enroll')
        expect(payload).toEqual({ owner: true })
        return { ok: true as const, value: { principalId: 'principal-owner', expiresAt: 4_000 } }
      }),
    }
    const client = createSharedBotsClient(rpc)
    const enrollOwner = client.enrollOwner
    if (enrollOwner === undefined) throw new Error('owner enrollment is unavailable')
    await expect(enrollOwner()).resolves.toMatchObject({ ok: true, value: { principalId: 'principal-owner' } })
    expect(client.retryScope).toBe('principal-owner')
  })

  it('clears a stale principal scope when the authenticated session is gone', async () => {
    let sessionCalls = 0
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/enroll') return { ok: true as const, value: { principalId: 'principal-old', expiresAt: 3_000 } }
        sessionCalls += 1
        return sessionCalls === 1
          ? { ok: true as const, value: { principalId: 'principal-new', expiresAt: 3_000 } }
          : { ok: false as const, error: { code: 'gateway/unauthorized', message: 'expired', details: {} } }
      }),
    }
    const client = createSharedBotsClient(rpc)
    await expect(client.enroll('old-code')).resolves.toMatchObject({ ok: true })
    expect(client.retryScope).toBe('principal-old')
    await expect(client.restoreRetryScope()).resolves.toMatchObject({ ok: true, value: { principalId: 'principal-new' } })
    expect(client.retryScope).toBe('principal-new')
    await expect(client.restoreRetryScope()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/unauthorized' } })
    expect(client.retryScope).toBeUndefined()
  })

  it('serializes scope refreshes without letting an older result overwrite a newer one', async () => {
    const first = Promise.withResolvers<{
      readonly ok: true
      readonly value: { readonly principalId: string; readonly expiresAt: number }
    }>()
    const second = Promise.withResolvers<{
      readonly ok: true
      readonly value: { readonly principalId: string; readonly expiresAt: number }
    }>()
    const secondStarted = Promise.withResolvers<boolean>()
    let calls = 0
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => {
        calls += 1
        if (calls === 1) return first.promise
        secondStarted.resolve(true)
        return second.promise
      }),
    }
    const client = createSharedBotsClient(rpc)
    const older = client.restoreRetryScope()
    const newer = client.restoreRetryScope()
    first.resolve({ ok: true, value: { principalId: 'principal-older', expiresAt: 3_000 } })
    await expect(older).resolves.toMatchObject({ ok: true, value: { principalId: 'principal-older' } })
    await secondStarted.promise
    second.resolve({ ok: true, value: { principalId: 'principal-newer', expiresAt: 3_000 } })
    await expect(newer).resolves.toMatchObject({ ok: true, value: { principalId: 'principal-newer' } })
    expect(client.retryScope).toBe('principal-newer')
  })

  it('clears the retry scope when an authenticated operation is rejected', async () => {
    let enrolled = false
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/enroll') {
          enrolled = true
          return { ok: true as const, value: { principalId: 'principal-member', expiresAt: 3_000 } }
        }
        expect(enrolled).toBe(true)
        return { ok: false as const, error: { code: 'gateway/unauthorized', message: 'expired', details: {} } }
      }),
    }
    const client = createSharedBotsClient(rpc)
    await expect(client.enroll('invite-code')).resolves.toMatchObject({ ok: true })
    expect(client.retryScope).toBe('principal-member')

    await expect(client.list()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/unauthorized' } })
    expect(client.retryScope).toBeUndefined()
  })

  it('does not let an older unauthorized response clear a newer principal', async () => {
    const oldList = Promise.withResolvers<{
      readonly ok: false
      readonly error: { readonly code: 'gateway/unauthorized'; readonly message: string; readonly details: Record<string, never> }
    }>()
    let enrollments = 0
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/enroll') {
          enrollments += 1
          return { ok: true as const, value: { principalId: `principal-${enrollments === 1 ? 'old' : 'new'}`, expiresAt: 3_000 } }
        }
        return oldList.promise
      }),
    }
    const client = createSharedBotsClient(rpc)
    await expect(client.enroll('old-code')).resolves.toMatchObject({ ok: true })
    const oldRequest = client.list()
    await expect(client.enroll('new-code')).resolves.toMatchObject({ ok: true, value: { principalId: 'principal-new' } })

    oldList.resolve({ ok: false, error: { code: 'gateway/unauthorized', message: 'old cookie', details: {} } })
    await expect(oldRequest).resolves.toMatchObject({ ok: false, error: { code: 'gateway/unauthorized' } })
    expect(client.retryScope).toBe('principal-new')
  })

  it('notifies subscribers for real principal transitions but not stale rejections', async () => {
    const oldList = Promise.withResolvers<{
      readonly ok: false
      readonly error: { readonly code: 'gateway/unauthorized'; readonly message: string; readonly details: Record<string, never> }
    }>()
    let enrollments = 0
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/enroll') {
          enrollments += 1
          return { ok: true as const, value: { principalId: `principal-${enrollments === 1 ? 'old' : 'new'}`, expiresAt: 3_000 } }
        }
        return oldList.promise
      }),
    }
    const client = createSharedBotsClient(rpc)
    const transitions: Array<string | undefined> = []
    const unsubscribe = client.subscribeAuth?.(() => { transitions.push(client.retryScope) })

    await client.enroll('old-code')
    const oldRequest = client.list()
    await client.enroll('new-code')
    oldList.resolve({ ok: false, error: { code: 'gateway/unauthorized', message: 'old cookie', details: {} } })
    await oldRequest
    unsubscribe?.()

    expect(transitions).toEqual([undefined, 'principal-old', undefined, 'principal-new'])
    expect(client.retryScope).toBe('principal-new')
  })

  it('propagates an auth invalidation between two shared client tabs', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    try {
      const rpc: ClientConnectionRpc = {
        call: vi.fn(async (_channel, endpoint) => endpoint === 'bots/share/enroll'
          ? { ok: true as const, value: { principalId: 'principal-member', expiresAt: 3_000 } }
          : { ok: true as const, value: { bots: [] } }),
      }
      const firstTab = createSharedBotsClient(rpc)
      const secondTab = createSharedBotsClient(rpc)
      const firstChanges: string[] = []
      const secondChanges: string[] = []
      const stopFirst = firstTab.subscribeAuth?.((change) => { if (change !== undefined) firstChanges.push(change.source) })
      const stopSecond = secondTab.subscribeAuth?.((change) => { if (change !== undefined) secondChanges.push(change.source) })
      await firstTab.enroll('first-code')
      await secondTab.enroll('second-code')

      broadcastSharedAuthChanged()
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

      expect(firstTab.retryScope).toBeUndefined()
      expect(secondTab.retryScope).toBeUndefined()
      expect(firstChanges).toContain('remote')
      expect(secondChanges).toContain('remote')
      stopFirst?.()
      stopSecond?.()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('broadcasts enrollment auth changes only after the enrollment settles', async () => {
    const posts: unknown[] = []
    class FakeBroadcastChannel {
      constructor(readonly name: string) {}
      addEventListener(): void {}
      removeEventListener(): void {}
      postMessage(data: unknown): void { posts.push(data) }
      close(): void {}
    }
    const enrollment = Promise.withResolvers<{
      readonly ok: true
      readonly value: { readonly principalId: string; readonly expiresAt: number }
    }>()
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => endpoint === 'bots/share/enroll'
        ? enrollment.promise
        : { ok: true as const, value: { bots: [] } }),
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    try {
      const client = createSharedBotsClient(rpc)
      const stop = client.subscribeAuth?.(() => {})
      const pending = client.enroll('delayed-code')
      expect(posts).toEqual([])
      enrollment.resolve({ ok: true, value: { principalId: 'principal-member', expiresAt: 3_000 } })
      await pending
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(posts).toHaveLength(1)
      expect(posts[0]).toMatchObject({ type: 'auth-invalidated' })
      stop?.()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not broadcast a failed enrollment as an ACL invalidation', async () => {
    const posts: unknown[] = []
    class FakeBroadcastChannel {
      constructor(readonly name: string) {}
      addEventListener(): void {}
      removeEventListener(): void {}
      postMessage(data: unknown): void { posts.push(data) }
      close(): void {}
    }
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: false as const, error: { code: 'gateway/unauthorized', message: 'invalid invite', details: {} } })),
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    try {
      const client = createSharedBotsClient(rpc)
      const stop = client.subscribeAuth?.(() => {})
      await expect(client.enroll('invalid-code')).resolves.toMatchObject({ ok: false })
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(posts).toEqual([])
      stop?.()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('lets a successful enrollment win over a queued cross-tab invalidation', async () => {
    const enrollment = Promise.withResolvers<{
      readonly ok: true
      readonly value: { readonly principalId: string; readonly expiresAt: number }
    }>()
    const rpcA: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => endpoint === 'bots/share/enroll'
        ? enrollment.promise
        : { ok: true as const, value: { bots: [] } }),
    }
    const rpcB: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: false as const, error: { code: 'gateway/unauthorized', message: 'expired', details: {} } })),
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    try {
      const enrollingTab = createSharedBotsClient(rpcA)
      const staleTab = createSharedBotsClient(rpcB)
      const stopEnrolling = enrollingTab.subscribeAuth?.(() => {})
      const stopStale = staleTab.subscribeAuth?.(() => {})
      const pendingEnrollment = enrollingTab.enroll('new-invite')
      const staleRestore = staleTab.restoreRetryScope()
      await expect(staleRestore).resolves.toMatchObject({ ok: false, error: { code: 'gateway/unauthorized' } })
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      enrollment.resolve({ ok: true, value: { principalId: 'principal-new', expiresAt: 3_000 } })
      await expect(pendingEnrollment).resolves.toMatchObject({ ok: true })
      expect(enrollingTab.retryScope).toBe('principal-new')
      stopEnrolling?.()
      stopStale?.()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps sender identities distinct across separate client instances', async () => {
    const rpcA: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: true as const, value: { principalId: 'principal-realm-a', expiresAt: 3_000 } })),
    }
    const rpcB: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: true as const, value: { principalId: 'principal-realm-b', expiresAt: 3_000 } })),
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    try {
      const firstRealmClient = createSharedBotsClient(rpcA)
      const secondRealmClient = createSharedBotsClient(rpcB)
      const stopFirst = firstRealmClient.subscribeAuth?.(() => {})
      const stopSecond = secondRealmClient.subscribeAuth?.(() => {})
      await secondRealmClient.enroll('second-realm-code')
      await firstRealmClient.enroll('first-realm-code')
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(secondRealmClient.retryScope).toBeUndefined()
      stopFirst?.()
      stopSecond?.()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
