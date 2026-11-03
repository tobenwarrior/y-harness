import type { ClientConnectionRpc } from '@yharness/client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import { createSharedBotsClient } from '../src/client/shared-client.ts'

describe('shared Bot client capabilities', () => {
  it('does not advertise group operations while the server route is fail-closed', () => {
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async () => ({ ok: true as const, value: {} })),
    }
    const client = createSharedBotsClient(rpc)

    expect(client.listGroups).toBeUndefined()
    expect(client.createGroup).toBeUndefined()
    expect(client.updateGroup).toBeUndefined()
    expect(client.inspectGroup).toBeUndefined()
    expect(client.sendGroupMessage).toBeUndefined()
    expect(rpc.call).not.toHaveBeenCalled()
  })
})
