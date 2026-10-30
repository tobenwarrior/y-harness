import { createUserMessage, type UserMessage } from '@yharness/llm'
import { SessionId, SessionSeq, type SessionEvent } from '@yharness/session'
import { describe, expect, it, vi } from 'vitest'
import {
  BotCollaborationService,
  BotMessageId,
  projectBotTranscript,
  type BotCollaborationHost,
} from '../src/collaboration.ts'
import { BotId, type BotView } from '../src/types.ts'

function bot(id: string, sessionId: string, name: string): BotView {
  return {
    id: BotId(id), sessionId: SessionId(sessionId), name, identity: 'agent', accent: 'violet', cwd: '/tmp',
    state: 'active', createdAt: 1, updatedAt: 1, availability: 'idle',
  }
}

function userEvent(message: ReturnType<typeof createUserMessage>, seq: number): SessionEvent<'user/message'> {
  return { type: 'user/message', seq: SessionSeq(seq), time: seq, data: message, surfaceOp: 'append' }
}

function harness() {
  const bots = [bot('bot-alpha', 'bot-session-alpha', 'Alpha'), bot('bot-beta', 'bot-session-beta', 'Beta')]
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
  return { service, client: service.bind({ id: SessionId('bot-session-alpha') }), bots, events, followups }
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
