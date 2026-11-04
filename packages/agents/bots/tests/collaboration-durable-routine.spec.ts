import { SessionId } from '@yharness/session'
import { describe, expect, it, vi } from 'vitest'
import { BotCollaborationService, BotMessageId, type BotCollaborationHost } from '../src/collaboration.ts'
import { BotId, type BotView } from '../src/types.ts'

function bot(id: string): BotView {
  return {
    id: BotId(id), sessionId: SessionId(`session-${id}`), name: id, identity: 'agent', accent: 'violet', cwd: '/tmp',
    state: 'active', createdAt: 1, updatedAt: 1, availability: 'idle', pinned: false, hidden: false,
  }
}

describe('durable peer delivery with event routines', () => {
  it('retains routine relay context and acknowledges the persisted delivery', async () => {
    const bots = [bot('alpha'), bot('beta')]
    const deliverMessage = vi.fn<NonNullable<BotCollaborationHost['deliverMessage']>>(async () => 'accepted')
    const recordDelivery = vi.fn<NonNullable<BotCollaborationHost['recordDelivery']>>(async () => 'accepted')
    const host: BotCollaborationHost = {
      listBots: async () => bots,
      inspectSession: async () => ({ events: [] }),
      resolveAgent: async () => ({ error: new Error('unexpected resolution') }),
      flushSession: async () => undefined,
      deliverMessage,
      recordDelivery,
      eventRoutineContext: () => ({ chainId: 'chain', depth: 2 }),
    }
    const client = await new BotCollaborationService(host).bind({ id: SessionId('session-alpha') })
    const messageId = BotMessageId('message-1')
    await expect(client.send({ targetBotId: BotId('beta'), text: 'Hello', messageId })).resolves.toMatchObject({ status: 'accepted' })
    expect(deliverMessage.mock.calls[0]?.[1].source).toMatchObject({
      kind: 'agent-message', botEventRoutine: { chainId: 'chain', depth: 2 },
    })
    expect(recordDelivery).toHaveBeenCalledWith(SessionId('session-beta'), {
      messageId, senderSessionId: SessionId('session-alpha'), status: 'accepted',
    })
  })

  it('does not acknowledge a delivery canceled before the durable receipt', async () => {
    const host: BotCollaborationHost = {
      listBots: async () => [bot('alpha'), bot('beta')],
      inspectSession: async () => ({ events: [] }),
      resolveAgent: async () => ({ error: new Error('unexpected resolution') }),
      flushSession: async () => undefined,
      deliverMessage: async () => 'accepted',
      recordDelivery: async () => 'canceled',
    }
    const client = await new BotCollaborationService(host).bind({ id: SessionId('session-alpha') })
    await expect(client.send({ targetBotId: BotId('beta'), text: 'Hello' })).rejects.toMatchObject({ code: 'durability-failed' })
  })
})
