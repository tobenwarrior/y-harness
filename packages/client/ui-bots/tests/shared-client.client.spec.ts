import type { ClientConnectionRpc } from '@yharness/client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import { createSharedBotsClient } from '../src/client/shared-client.ts'

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

  it('does not let an older scope refresh overwrite a newer one', async () => {
    const first = Promise.withResolvers<{
      readonly ok: true
      readonly value: { readonly principalId: string; readonly expiresAt: number }
    }>()
    const second = Promise.withResolvers<{
      readonly ok: true
      readonly value: { readonly principalId: string; readonly expiresAt: number }
    }>()
    let calls = 0
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      }),
    }
    const client = createSharedBotsClient(rpc)
    const older = client.restoreRetryScope()
    const newer = client.restoreRetryScope()
    second.resolve({ ok: true, value: { principalId: 'principal-newer', expiresAt: 3_000 } })
    await expect(newer).resolves.toMatchObject({ ok: true, value: { principalId: 'principal-newer' } })
    first.resolve({ ok: true, value: { principalId: 'principal-older', expiresAt: 3_000 } })
    await expect(older).resolves.toMatchObject({ ok: true, value: { principalId: 'principal-older' } })
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
})
