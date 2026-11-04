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
})
