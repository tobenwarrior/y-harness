import { SessionId } from '@yharness/session'
import { describe, expect, it, vi } from 'vitest'
import {
  BotMessageId,
  type BotCollaborationClient,
  type BotDynamicToolEvent,
} from '../src/collaboration.ts'
import { BotId } from '../src/types.ts'
import { createBotNativeToolProvider, type BotNativeToolContext } from '../src/native-tools.ts'

function client(): BotCollaborationClient {
  return {
    sender: { id: BotId('bot-alpha'), name: 'Alpha', availability: 'idle', state: 'active' },
    list: vi.fn<BotCollaborationClient['list']>(async () => [{ id: BotId('bot-beta'), name: 'Beta', availability: 'idle', state: 'active' }]),
    inspect: vi.fn<BotCollaborationClient['inspect']>(async botId => ({ bot: { id: botId, name: 'Beta', availability: 'idle', state: 'active' }, recent: [] })),
    send: vi.fn<BotCollaborationClient['send']>(async request => ({
      messageId: request.messageId ?? BotMessageId('generated'), status: 'accepted' as const,
      sender: { id: BotId('bot-alpha'), name: 'Alpha', availability: 'idle', state: 'active' },
      target: { id: request.targetBotId, name: 'Beta', availability: 'idle', state: 'active' },
    })),
  }
}

function context(overrides: Partial<BotNativeToolContext> = {}): BotNativeToolContext {
  return {
    callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId: SessionId('bot-session-alpha'),
    signal: new AbortController().signal, approvalPolicy: 'on-request', requestApproval: async () => true,
    ...overrides,
  }
}

describe('native Bot actions', () => {
  it('binds to the live sender, exposes only collaboration actions, and persists bounded lifecycles', async () => {
    const bound = client()
    const persisted: BotDynamicToolEvent[] = []
    const provider = createBotNativeToolProvider({
      bind: vi.fn(async () => bound), persist: async (event) => { persisted.push(event) }, replay: async () => [],
    })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    expect(tools.map(tool => tool.name)).toEqual(['list_bots', 'inspect_bot', 'send_bot_message'])
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    await expect(send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context())).resolves.toMatchObject({ success: true })
    const firstRequest = vi.mocked(bound.send).mock.calls[0]?.[0]
    expect(firstRequest).toMatchObject({ targetBotId: BotId('bot-beta'), text: 'hello' })
    expect(firstRequest?.messageId).toMatch(/^codex-/)

    await provider.observe({ phase: 'started', name: 'send_bot_message', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' } })
    await provider.observe({ phase: 'settled', name: 'send_bot_message', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
      result: { success: true, contentItems: [{ type: 'inputText', text: 'accepted' }] } })
    expect(persisted).toHaveLength(2)
    expect(persisted[1]).toMatchObject({ phase: 'settled', result: { success: true } })
  })

  it('reuses the durable implicit identity when a native call gets a new call id', async () => {
    const bound = client()
    let replayed: readonly BotDynamicToolEvent[] = []
    const provider = createBotNativeToolProvider({
      bind: async () => bound, persist: async () => {}, replay: async () => replayed,
    })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    await send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({ callId: 'call-1' }))
    const firstRequest = vi.mocked(bound.send).mock.calls[0]?.[0]
    if (firstRequest?.messageId === undefined) throw new Error('expected an implicit message id')
    replayed = [{
      phase: 'started', name: 'send_bot_message', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
    }, {
      phase: 'started', name: 'send_bot_message', callId: 'call-2', threadId: 'thread-after-retry', turnId: 'turn-after-retry',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
    }]
    await send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({
      callId: 'call-2', threadId: 'thread-after-retry', turnId: 'turn-after-retry',
    }))
    expect(vi.mocked(bound.send).mock.calls[1]?.[0]?.messageId).toBe(firstRequest.messageId)
  })

  it('does not hide a prior explicit identity when a provider reuses its call identity', async () => {
    const bound = client()
    const replayed: readonly BotDynamicToolEvent[] = [{
      phase: 'started', name: 'send_bot_message', callId: 'reused-call', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: {
        targetBotId: 'bot-beta', text: 'hello', messageId: 'explicit-prior-id',
      },
    }, {
      phase: 'settled', name: 'send_bot_message', callId: 'reused-call', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: {
        targetBotId: 'bot-beta', text: 'hello', messageId: 'explicit-prior-id',
      }, result: { success: true, contentItems: [{ type: 'inputText', text: '{"status":"accepted"}' }] },
    }, {
      phase: 'started', name: 'send_bot_message', callId: 'reused-call', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
    }]
    const provider = createBotNativeToolProvider({ bind: async () => bound, persist: async () => {}, replay: async () => replayed })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    const result = await send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({ callId: 'reused-call' }))
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('explicit-prior-id')
    expect(bound.send).not.toHaveBeenCalled()
  })

  it('reports uncertain outcome instead of guessing between multiple pending deliveries', async () => {
    const bound = client()
    const replayed: readonly BotDynamicToolEvent[] = [
      { phase: 'started', name: 'send_bot_message', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1',
        sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' } },
      { phase: 'started', name: 'send_bot_message', callId: 'call-2', threadId: 'thread-2', turnId: 'turn-2',
        sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' } },
    ]
    const provider = createBotNativeToolProvider({ bind: async () => bound, persist: async () => {}, replay: async () => replayed })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    const result = await send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({ callId: 'call-3' }))
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('uncertain-outcome')
    expect(bound.send).not.toHaveBeenCalled()
  })

  it('does not let the current started record or a known no-effect failure poison a retry', async () => {
    const bound = client()
    let replayed: readonly BotDynamicToolEvent[] = [{
      phase: 'started', name: 'send_bot_message', callId: 'call-current', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
    }]
    const provider = createBotNativeToolProvider({ bind: async () => bound, persist: async () => {}, replay: async () => replayed })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    await expect(send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context())).resolves.toMatchObject({ success: true })
    expect(bound.send).toHaveBeenCalledOnce()

    replayed = [{
      phase: 'started', name: 'send_bot_message', callId: 'call-denied', threadId: 'thread-denied', turnId: 'turn-denied',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'different' },
    }, {
      phase: 'settled', name: 'send_bot_message', callId: 'call-denied', threadId: 'thread-denied', turnId: 'turn-denied',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'different' },
      result: { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'approval-denied' }) }] },
    }]
    await expect(send.execute({ targetBotId: 'bot-beta', text: 'hello again' }, context({ callId: 'call-after-denied' }))).resolves.toMatchObject({ success: true })
    expect(bound.send).toHaveBeenCalledTimes(2)
  })

  it('keeps a delivery failure with an unknown side effect uncertain', async () => {
    const bound = client()
    const replayed: readonly BotDynamicToolEvent[] = [{
      phase: 'started', name: 'send_bot_message', callId: 'call-uncertain', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
    }, {
      phase: 'settled', name: 'send_bot_message', callId: 'call-uncertain', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
      result: { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'durability-failed' }) }] },
    }, {
      phase: 'started', name: 'send_bot_message', callId: 'call-uncertain-2', threadId: 'thread-2', turnId: 'turn-2',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
    }, {
      phase: 'settled', name: 'send_bot_message', callId: 'call-uncertain-2', threadId: 'thread-2', turnId: 'turn-2',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
      result: { success: false, contentItems: [{ type: 'inputText' as const, text: JSON.stringify({ error: 'durability-failed' }) }] },
    }, {
      phase: 'started', name: 'send_bot_message', callId: 'call-retry', threadId: 'thread-retry', turnId: 'turn-retry',
      sessionId: SessionId('bot-session-alpha'), arguments: { targetBotId: 'bot-beta', text: 'hello' },
    }]
    const provider = createBotNativeToolProvider({ bind: async () => bound, persist: async () => {}, replay: async () => replayed })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    const result = await send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({ callId: 'call-retry' }))
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('uncertain-outcome')
    expect(bound.send).not.toHaveBeenCalled()
  })

  it('does not send when cancellation arrives while approval is pending', async () => {
    const bound = client()
    const controller = new AbortController()
    const approval = Promise.withResolvers<boolean>()
    let approvalRequested = false
    const provider = createBotNativeToolProvider({ bind: async () => bound, persist: async () => {}, replay: async () => [] })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    const running = send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({
      signal: controller.signal,
      requestApproval: async () => { approvalRequested = true; return approval.promise },
    }))
    await vi.waitFor(() => { expect(approvalRequested).toBe(true) })
    controller.abort()
    approval.resolve(true)
    const result = await running
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('cancelled')
    expect(bound.send).not.toHaveBeenCalled()
  })

  it('does not send when cancellation arrives while replay is pending', async () => {
    const bound = client()
    const controller = new AbortController()
    const replay = Promise.withResolvers<readonly BotDynamicToolEvent[]>()
    let replayRequested = false
    const provider = createBotNativeToolProvider({
      bind: async () => bound, persist: async () => {}, replay: async () => {
        replayRequested = true
        return replay.promise
      },
    })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    const running = send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({ signal: controller.signal }))
    await vi.waitFor(() => { expect(replayRequested).toBe(true) })
    controller.abort()
    replay.resolve([])
    const result = await running
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('cancelled')
    expect(bound.send).not.toHaveBeenCalled()
  })

  it('fails closed when the Session approval policy disallows messaging', async () => {
    const bound = client()
    const provider = createBotNativeToolProvider({ bind: async () => bound, persist: async () => {}, replay: async () => [] })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const send = tools.find(tool => tool.name === 'send_bot_message')
    if (send === undefined) throw new Error('send_bot_message was not registered')
    await expect(send.execute({ targetBotId: 'bot-beta', text: 'hello' }, context({ approvalPolicy: 'never' }))).resolves.toMatchObject({
      success: false,
    })
    expect(bound.send).not.toHaveBeenCalled()
  })

  it('bounds native output before logging so the audit matches the model result', async () => {
    const bound = client()
    vi.mocked(bound.list).mockResolvedValue([{
      id: BotId('bot-beta'), name: 'Beta', availability: 'idle', state: 'active',
      description: 'x'.repeat(20_000),
    }])
    const persisted: BotDynamicToolEvent[] = []
    const provider = createBotNativeToolProvider({
      bind: async () => bound, persist: async (event) => { persisted.push(event) }, replay: async () => [],
    })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const list = tools.find(tool => tool.name === 'list_bots')
    if (list === undefined) throw new Error('list_bots was not registered')
    const result = await list.execute({}, context())
    const resultText = result.contentItems[0]?.text
    expect(resultText).toContain('result-too-large')
    expect(resultText?.length).toBeLessThanOrEqual(16_000)

    await provider.observe({ phase: 'settled', name: 'list_bots', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: {}, result })
    expect(persisted[0]?.result?.contentItems[0]?.text).toBe(resultText)
  })

  it('bounds aggregate native output before logging', async () => {
    const persisted: BotDynamicToolEvent[] = []
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async (event) => { persisted.push(event) }, replay: async () => [],
    })
    const oversized = {
      success: true,
      contentItems: [
        { type: 'inputText' as const, text: 'a'.repeat(10_000) },
        { type: 'inputText' as const, text: 'b'.repeat(10_000) },
      ],
    }
    await provider.observe({ phase: 'settled', name: 'list_bots', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1',
      sessionId: SessionId('bot-session-alpha'), arguments: {}, result: oversized })
    const persistedResult = persisted[0]?.result
    expect(persistedResult?.contentItems[0]?.text).toContain('result-too-large')
    expect(JSON.stringify(persistedResult).length).toBeLessThanOrEqual(16_000)
  })
})
