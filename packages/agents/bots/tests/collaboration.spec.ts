import { createUserMessage, freezeMessage, MessageId, type UserMessage } from '@yharness/llm'
import { SessionId, SessionSeq, type SessionEvent } from '@yharness/session'
import { describe, expect, it, vi } from 'vitest'
import {
  BotCollaborationService,
  BotMessageId,
  projectBotTranscript,
  type BotCollaborationHost,
} from '../src/collaboration.ts'
import { BotGroupId, BotGroupMessageId } from '../src/group-chat.ts'
import { BotId, type BotView } from '../src/types.ts'

function bot(id: string, sessionId: string, name: string): BotView {
  return {
    id: BotId(id), sessionId: SessionId(sessionId), name, identity: 'agent', accent: 'violet', cwd: '/tmp',
    state: 'active', createdAt: 1, updatedAt: 1, availability: 'idle', pinned: false, hidden: false,
  }
}

function userEvent(message: ReturnType<typeof createUserMessage>, seq: number): SessionEvent<'user/message'> {
  return { type: 'user/message', seq: SessionSeq(seq), time: seq, data: message, surfaceOp: 'append' }
}

function harness(entries = [bot('bot-alpha', 'bot-session-alpha', 'Alpha'), bot('bot-beta', 'bot-session-beta', 'Beta')]) {
  const bots = entries
  const events = new Map<string, SessionEvent[]>(bots.map(entry => [String(entry.sessionId), []]))
  const followups = new Map<string, ReturnType<typeof vi.fn<(message: UserMessage) => void>>>()
  const host: BotCollaborationHost = {
    listBots: async () => bots,
    inspectSession: async sessionId => ({ events: events.get(String(sessionId)) ?? [] }),
    resolveAgent: async (sessionId) => {
      if (!events.has(String(sessionId))) return { error: new Error('missing Session') }
      const followup = followups.get(String(sessionId)) ?? vi.fn<(message: UserMessage) => void>((message) => {
        const target = events.get(String(sessionId))!
        target.push(userEvent(message, target.length + 1))
      })
      followups.set(String(sessionId), followup)
      return { agent: { id: sessionId, followup } }
    },
    flushSession: async () => undefined,
  }
  const service = new BotCollaborationService(host)
  return { service, client: service.bind({ id: SessionId('bot-session-alpha') }), bots, events, followups, host }
}

function assistantEvent(text: string, seq: number, turn = 1): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message', seq: SessionSeq(seq), time: seq,
    data: {
      turn, step: seq,
      message: freezeMessage({
        id: MessageId(`assistant-${String(seq)}`), role: 'assistant',
        content: [{ type: 'text', text }], source: { kind: 'model', provider: 'test', model: 'test' },
      }), stream: [],
    }, surfaceOp: 'append',
  }
}

describe('Bot collaboration seam', () => {
  it('lists roster metadata and projects only bounded text', async () => {
    const h = harness()
    const client = await h.client
    const listed = await client.list()
    expect(listed).toEqual([
      { id: BotId('bot-beta'), name: 'Beta', availability: 'idle', state: 'active' },
    ])
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    h.events.get('bot-session-beta')!.push(userEvent(message, 1))
    const inspected = await client.inspect(BotId('bot-beta'))
    expect(inspected).toMatchObject({
      bot: { name: 'Beta' }, recent: [{ role: 'user' }],
    })
    expect(inspected.recent[0]?.text).toContain('Untrusted Bot transcript')
    expect(inspected.recent[0]?.text).toContain('hello')
    expect(inspected.recent[0]?.text).toContain('End untrusted Bot transcript')
  })

  it('does not leak group requests or their assistant replies through generic peer inspection', async () => {
    const h = harness([
      bot('bot-alpha', 'bot-session-alpha', 'Alpha'),
      bot('bot-beta', 'bot-session-beta', 'Beta'),
      bot('bot-gamma', 'bot-session-gamma', 'Gamma'),
    ])
    const targetEvents = h.events.get('bot-session-beta')
    if (targetEvents === undefined) throw new Error('target events were not created')
    targetEvents.push({ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } })
    targetEvents.push(userEvent(createUserMessage({
      content: [{ type: 'text', text: 'Shared secret for Alpha and Beta.' }],
      source: { kind: 'bot-group-message', groupId: BotGroupId('bot-group-alpha'), messageId: BotGroupMessageId('bot-group-message-alpha') },
    }), 1))
    targetEvents.push(assistantEvent('Beta shared reply.', 2))
    targetEvents.push(userEvent(createUserMessage({
      content: [{ type: 'text', text: 'Gamma may see this private request.' }], source: { kind: 'user' },
    }), 3))
    targetEvents.push(assistantEvent('Beta private reply.', 4))
    targetEvents.push({ type: 'turn/end', seq: SessionSeq(5), time: 5, data: { turn: 1, reason: { kind: 'completed' } } })
    targetEvents.push({ type: 'turn/start', seq: SessionSeq(6), time: 6, data: { turn: 2 } })
    targetEvents.push(userEvent(createUserMessage({
      content: [{ type: 'text', text: 'A later private request.' }], source: { kind: 'user' },
    }), 7))
    targetEvents.push(assistantEvent('Beta later private reply.', 8, 2))
    targetEvents.push({ type: 'turn/end', seq: SessionSeq(9), time: 9, data: { turn: 2, reason: { kind: 'completed' } } })
    targetEvents.push({ type: 'turn/start', seq: SessionSeq(10), time: 10, data: { turn: 3 } })
    targetEvents.push(userEvent(createUserMessage({
      content: [{ type: 'text', text: 'Compacted shared secret.' }],
      source: { kind: 'bot-group-message', groupId: BotGroupId('bot-group-alpha'), messageId: BotGroupMessageId('bot-group-message-compacted') },
    }), 11))
    const compactedReplacement = userEvent(createUserMessage({
      content: [{ type: 'text', text: 'Compacted surface replacement.' }], source: { kind: 'user' },
    }), 12)
    targetEvents.push({ ...compactedReplacement, sourceEventSeqs: [SessionSeq(11)] })
    targetEvents.push(assistantEvent('Beta compacted shared reply.', 13, 3))

    const gamma = await h.service.bind({ id: SessionId('bot-session-gamma') })
    const inspected = await gamma.inspect(BotId('bot-beta'))
    expect(inspected.recent.map(entry => entry.text).join('\n')).not.toContain('Shared secret')
    expect(inspected.recent.map(entry => entry.text).join('\n')).not.toContain('Beta shared reply')
    expect(inspected.recent.map(entry => entry.text).join('\n')).not.toContain('Beta private reply')
    expect(inspected.recent.map(entry => entry.text).join('\n')).not.toContain('Compacted shared secret')
    expect(inspected.recent.map(entry => entry.text).join('\n')).not.toContain('Beta compacted shared reply')
    expect(inspected.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', text: expect.stringContaining('A later private request.') }),
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('Beta later private reply.') }),
    ]))
  })

  it('does not leak event-routine prompts or results through generic peer inspection', async () => {
    const h = harness()
    const targetEvents = h.events.get('bot-session-beta')
    if (targetEvents === undefined) throw new Error('target events were not created')
    targetEvents.push({ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } })
    targetEvents.push(userEvent(createUserMessage({
      content: [{ type: 'text', text: '[BOT EVENT ROUTINE]\nPrivate routine prompt.' }],
      source: {
        kind: 'bot-event-routine', form: 'notice', summary: 'Routine triggered',
        routineId: 'bot-event-routine-private', triggerEventSeq: 3,
      },
    }), 1))
    targetEvents.push(assistantEvent('Private routine result.', 2))

    const client = await h.client
    const inspected = await client.inspect(BotId('bot-beta'))
    const text = inspected.recent.map(entry => entry.text).join('\n')
    expect(text).not.toContain('Private routine prompt.')
    expect(text).not.toContain('Private routine result.')
  })

  it('delivers to the target Session with durable sender identity and is idempotent', async () => {
    const h = harness()
    const client = await h.client
    const messageId = BotMessageId('bot-message-fixed')
    const first = await client.send({
      targetBotId: BotId('bot-beta'),
      text: 'Please check the release queue.', messageId,
    })
    expect(first.status).toBe('accepted')
    const followup = h.followups.get('bot-session-beta')!
    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls[0]?.[0]?.id).toBe(messageId)
    expect(followup.mock.calls[0]?.[0]?.source).toMatchObject({
      kind: 'agent-message', form: 'relay', senderSessionId: SessionId('bot-session-alpha'),
    })
    await expect(client.send({
      targetBotId: BotId('bot-beta'),
      text: 'Please check the release queue.', messageId,
    })).resolves.toMatchObject({ status: 'duplicate', messageId })
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('does not acknowledge a peer message canceled during the durability flush', async () => {
    const bots = [bot('bot-alpha', 'bot-session-alpha', 'Alpha'), bot('bot-beta', 'bot-session-beta', 'Beta')]
    const events = new Map<string, SessionEvent[]>(bots.map(entry => [String(entry.sessionId), []]))
    const followup = vi.fn<(message: UserMessage) => void>((message) => {
      events.get('bot-session-beta')!.push({
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1,
        data: { target: 'next-turn', start: 0, inserted: [message] },
      })
    })
    const host: BotCollaborationHost = {
      listBots: async () => bots,
      inspectSession: async sessionId => ({ events: events.get(String(sessionId)) ?? [] }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, followup } }),
      flushSession: vi.fn(async () => {
        const message = followup.mock.calls[0]?.[0]
        if (message === undefined) throw new Error('peer message was not admitted before flush')
        events.get('bot-session-beta')!.push({
          type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 2,
          data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
        })
      }),
    }
    const client = await new BotCollaborationService(host).bind({ id: SessionId('bot-session-alpha') })
    await expect(client.send({
      targetBotId: BotId('bot-beta'), text: 'This must not be acknowledged.', messageId: BotMessageId('peer-canceled-after-flush'),
    })).rejects.toMatchObject({ code: 'durability-failed' })
    expect(followup).toHaveBeenCalledOnce()
    expect(host.flushSession).toHaveBeenCalledOnce()
  })

  it('rejects a peer message canceled after the first receipt check', async () => {
    const bots = [bot('bot-alpha', 'bot-session-alpha', 'Alpha'), bot('bot-beta', 'bot-session-beta', 'Beta')]
    const events = new Map<string, SessionEvent[]>(bots.map(entry => [String(entry.sessionId), []]))
    const followup = vi.fn<(message: UserMessage) => void>((message) => {
      events.get('bot-session-beta')!.push({
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1,
        data: { target: 'next-turn', start: 0, inserted: [message] },
      })
    })
    let targetInspections = 0
    const host: BotCollaborationHost = {
      listBots: async () => bots,
      inspectSession: async (sessionId) => {
        const targetEvents = events.get(String(sessionId)) ?? []
        if (String(sessionId) === 'bot-session-beta') {
          targetInspections += 1
          if (targetInspections === 2) {
            queueMicrotask(() => {
              targetEvents.push({
                type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 2,
                data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
              })
            })
          }
        }
        return { events: [...targetEvents] }
      },
      resolveAgent: async sessionId => ({ agent: { id: sessionId, followup } }),
      flushSession: vi.fn(async () => undefined),
    }
    const client = await new BotCollaborationService(host).bind({ id: SessionId('bot-session-alpha') })
    await expect(client.send({
      targetBotId: BotId('bot-beta'), text: 'This late cancellation must be rejected.', messageId: BotMessageId('peer-late-cancel'),
    })).rejects.toMatchObject({ code: 'durability-failed' })
    expect(followup).toHaveBeenCalledOnce()
    expect(targetInspections).toBe(3)
  })

  it('checks cancellation after target resume and before followup', async () => {
    const senderSessionId = SessionId('bot-session-alpha')
    const targetSessionId = SessionId('bot-session-beta')
    const bots = [bot('bot-alpha', String(senderSessionId), 'Alpha'), bot('bot-beta', String(targetSessionId), 'Beta')]
    const controller = new AbortController()
    const followup = vi.fn<(message: UserMessage) => void>()
    const host: BotCollaborationHost = {
      listBots: async () => bots,
      inspectSession: async () => ({ events: [] }),
      resolveAgent: async (sessionId) => {
        controller.abort()
        return { agent: { id: sessionId, followup } }
      },
      flushSession: vi.fn(async () => undefined),
    }
    const service = new BotCollaborationService(host)
    const client = await service.bind({ id: senderSessionId })
    await expect(client.send({
      targetBotId: BotId('bot-beta'), text: 'hello', messageId: BotMessageId('cancelled-message'), signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(followup).not.toHaveBeenCalled()
    expect(host.flushSession).not.toHaveBeenCalled()
  })

  it('recognizes a queued inbox receipt after a restart before the turn claims it', async () => {
    const h = harness()
    const client = await h.client
    const messageId = BotMessageId('bot-message-pending')
    await client.send({
      targetBotId: BotId('bot-beta'),
      text: 'Keep this queued.', messageId,
    })
    const followup = h.followups.get('bot-session-beta')!
    const queued = followup.mock.calls[0]?.[0]
    if (queued === undefined) throw new Error('expected a queued message')
    const targetEvents = h.events.get('bot-session-beta')!
    targetEvents.splice(0, targetEvents.length, {
      type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [queued] },
    })
    await expect(client.send({
      targetBotId: BotId('bot-beta'),
      text: 'Keep this queued.', messageId,
    })).resolves.toMatchObject({ status: 'duplicate', messageId })
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('uses the host delivery transaction when two Bot services retry one message concurrently', async () => {
    const h = harness()
    const first = await h.client
    const secondService = new BotCollaborationService(h.host)
    const second = await secondService.bind({ id: SessionId('bot-session-alpha') })
    const messageId = BotMessageId('cross-process-message')
    const delivery = vi.fn(async (target: BotView, message: UserMessage) => {
      const targetEvents = h.events.get(String(target.sessionId))
      if (targetEvents === undefined) throw new Error('missing target')
      if (hasMessageForTest(targetEvents, message.id)) return 'duplicate' as const
      targetEvents.push(userEvent(message, targetEvents.length + 1))
      return 'accepted' as const
    })
    const hostWithDelivery = h.host as BotCollaborationHost & {
      deliverMessage: typeof delivery
    }
    hostWithDelivery.deliverMessage = delivery

    await expect(Promise.all([
      first.send({ targetBotId: BotId('bot-beta'), text: 'same retry', messageId }),
      second.send({ targetBotId: BotId('bot-beta'), text: 'same retry', messageId }),
    ])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'accepted', messageId }),
      expect.objectContaining({ status: 'duplicate', messageId }),
    ]))
    expect(delivery).toHaveBeenCalledTimes(2)
    expect(h.followups.get('bot-session-beta')).toBeUndefined()
    expect(h.events.get('bot-session-beta')).toHaveLength(1)
  })

  it('recognizes a claimed inbox receipt before the target surface event', async () => {
    const h = harness()
    const client = await h.client
    const messageId = BotMessageId('bot-message-claimed')
    await client.send({ targetBotId: BotId('bot-beta'), text: 'Keep this claimed.', messageId })
    const followup = h.followups.get('bot-session-beta')!
    const claimed = followup.mock.calls[0]?.[0]
    if (claimed === undefined) throw new Error('expected a claimed message')
    const targetEvents = h.events.get('bot-session-beta')!
    targetEvents.splice(0, targetEvents.length,
      { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1,
        data: { target: 'next-turn', start: 0, inserted: [claimed] } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 2,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    )
    await expect(client.send({
      targetBotId: BotId('bot-beta'), text: 'Keep this claimed.', messageId,
    })).resolves.toMatchObject({ status: 'duplicate', messageId })
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('recognizes a claimed group inbox receipt before the target surface event', async () => {
    const bots = [bot('bot-alpha', 'bot-session-alpha', 'Alpha'), bot('bot-beta', 'bot-session-beta', 'Beta')]
    const events = new Map<string, SessionEvent[]>(bots.map(entry => [String(entry.sessionId), []]))
    const followup = vi.fn<(message: UserMessage) => void>((message) => {
      events.get('bot-session-beta')!.push({
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1,
        data: { target: 'next-turn', start: 0, inserted: [message] },
      })
    })
    const host: BotCollaborationHost = {
      listBots: async () => bots,
      inspectSession: async sessionId => ({ events: events.get(String(sessionId)) ?? [] }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, followup } }),
      flushSession: async () => undefined,
    }
    const service = new BotCollaborationService(host)
    const request = {
      targetBotId: BotId('bot-beta'), groupId: BotGroupId('bot-group-claimed'), groupName: 'Claimed room',
      text: 'Do not duplicate this group message.', messageId: BotMessageId('bot-group-message-claimed'),
    }

    await expect(service.sendExternal(request)).resolves.toBe('accepted')
    events.get('bot-session-beta')!.push({
      type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 2,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    await expect(service.sendExternal(request)).resolves.toBe('duplicate')
    expect(followup).toHaveBeenCalledOnce()
  })

  it('retries a canceled inbox delivery with the same message id', async () => {
    const h = harness()
    const client = await h.client
    const messageId = BotMessageId('bot-message-canceled')
    await client.send({ targetBotId: BotId('bot-beta'), text: 'Retry this canceled message.', messageId })
    const followup = h.followups.get('bot-session-beta')!
    const canceled = followup.mock.calls[0]?.[0]
    if (canceled === undefined) throw new Error('expected a canceled message')
    const targetEvents = h.events.get('bot-session-beta')!
    targetEvents.splice(0, targetEvents.length,
      { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1,
        data: { target: 'next-turn', start: 0, inserted: [canceled] } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 2,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
    )
    await expect(client.send({
      targetBotId: BotId('bot-beta'), text: 'Retry this canceled message.', messageId,
    })).resolves.toMatchObject({ status: 'accepted', messageId })
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('rejects unbounded message identities before touching the target Session', async () => {
    const h = harness()
    const client = await h.client
    await expect(client.send({
      targetBotId: BotId('bot-beta'), text: 'hello', messageId: BotMessageId('x'.repeat(257)),
    })).rejects.toMatchObject({ code: 'message-invalid' })
    expect(h.followups.size).toBe(0)
  })

  it('rejects self-send, unknown senders, and unknown targets', async () => {
    const h = harness()
    const client = await h.client
    await expect(client.send({
      targetBotId: BotId('bot-alpha'), text: 'no',
    })).rejects.toMatchObject({ code: 'self-message' })
    await expect(client.inspect(BotId('bot-alpha'))).rejects.toMatchObject({ code: 'self-inspection' })
    await expect(h.service.bind({ id: SessionId('ordinary-session') })).rejects.toMatchObject({ code: 'sender-not-bot' })
    await expect(client.send({
      targetBotId: BotId('bot-missing'), text: 'no',
    })).rejects.toMatchObject({ code: 'target-not-found' })
  })

  it('keeps tool and reasoning blocks out of inspection projections', () => {
    const message = createUserMessage({ content: [
      { type: 'text', text: 'visible' },
      { type: 'reasoning', text: 'private reasoning' },
    ], source: { kind: 'user' } })
    const event = userEvent(message, 1)
    expect(projectBotTranscript([event])).toEqual([{ role: 'user', text: 'visible' }])
  })
})

function hasMessageForTest(events: readonly SessionEvent[], messageId: string): boolean {
  return events.some(event => event.type === 'user/message' && event.data.id === messageId)
}
