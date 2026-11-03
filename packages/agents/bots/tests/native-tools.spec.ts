import { SessionId } from '@yharness/session'
import { describe, expect, it, vi } from 'vitest'
import {
  BotCollaborationError,
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
  it('offers approved routine actions bound to the Bot Session', async () => {
    const routine = vi.fn(async (action: string, args: Record<string, unknown>) => ({ action, args }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, replay: async () => [], routine,
      routineAvailable: async () => true,
    })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
    ]))
    const list = tools.find(tool => tool.name === 'schedule_list')
    const create = tools.find(tool => tool.name === 'schedule_create')
    if (list === undefined || create === undefined) throw new Error('routine tools missing')
    await expect(list.execute({}, context())).resolves.toMatchObject({ success: true })
    expect(routine).toHaveBeenCalledWith('list', {}, expect.objectContaining({ sessionId: SessionId('bot-session-alpha') }))
    await expect(create.execute({ title: 'Daily check' }, context({ requestApproval: async () => false })))
      .resolves.toMatchObject({ success: false })
    expect(routine).toHaveBeenCalledTimes(1)
    await expect(create.execute({ title: 'Daily check' }, context())).resolves.toMatchObject({ success: true })
    expect(routine).toHaveBeenCalledWith('create', { title: 'Daily check' }, expect.anything())
  })

  it('releases a durable reservation when approval is cancelled', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const release = vi.fn(async () => {})
    const controller = new AbortController()
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, replay: async () => [],
      routine: vi.fn(async () => ({ id: 'schedule-1' })),
      routineReserve: async () => ({ status: 'reserved' }), routineRelease: release,
      routineAvailable: async () => true,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const approval = Promise.withResolvers<boolean>()
    const approvalRequested = Promise.withResolvers<true>()
    const pending = create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, context({
      sessionId, signal: controller.signal, requestApproval: async () => { approvalRequested.resolve(true); return approval.promise },
    }))
    await approvalRequested.promise
    controller.abort()
    approval.resolve(true)
    await expect(pending).resolves.toMatchObject({ success: false })
    expect(release).toHaveBeenCalledOnce()
  })

  it('blocks a cross-call retry while an earlier routine outcome is uncertain', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const routine = vi.fn(async (action: string, args: Record<string, unknown>) => ({ action, args }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine,
      routineAvailable: async () => true,
      replay: async () => [{
        phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: { title: ' Daily check ', prompt: ' Check the report ' },
      }],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check', prompt: 'Check the report' }, context({ sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn' }))
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('uncertain-outcome')
    expect(routine).not.toHaveBeenCalled()
  })

  it('allows a cross-call retry after the Schedule service proves the request is absent', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const routine = vi.fn(async (action: string, args: Record<string, unknown>) => ({ action, args }))
    const persisted: BotDynamicToolEvent[] = []
    const replayed: BotDynamicToolEvent[] = [{
      phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
      arguments: { title: ' Daily check ', prompt: ' Check the report ' },
    }]
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async (event) => { persisted.push(event); replayed.push(event) }, routine,
      routineReconcile: async () => ({ status: 'absent' }),
      routineAvailable: async () => true,
      replay: async () => replayed,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check', prompt: 'Check the report' }, context({
      sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn',
    }))
    expect(result.success).toBe(true)
    expect(routine).toHaveBeenCalledOnce()
    expect(persisted).toContainEqual(expect.objectContaining({
      phase: 'settled', callId: 'earlier', result: expect.objectContaining({ success: false }),
    }))
  })

  it('keeps a cross-call retry uncertain until Schedule registers the earlier operation', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const routine = vi.fn(async () => ({ id: 'schedule-new' }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine,
      routineReconcile: async () => ({ status: 'unknown' }),
      routineAvailable: async () => true,
      replay: async () => [{
        phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: { title: 'Daily check', prompt: 'Check the report' },
      }],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check', prompt: 'Check the report' }, context({
      sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn',
    }))
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('uncertain-outcome')
    expect(routine).not.toHaveBeenCalled()
  })

  it('retires an unregistered replayed start when no approval call is still live', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const replayed: BotDynamicToolEvent[] = [{
      phase: 'started', name: 'schedule_create', callId: 'abandoned', threadId: 'old', turnId: 'old', sessionId,
      arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 },
    }]
    const persisted: BotDynamicToolEvent[] = []
    const routine = vi.fn(async () => ({ id: 'schedule-new' }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async (event) => { persisted.push(event); replayed.push(event) }, routine,
      routineReconcile: async () => ({ status: 'unknown' }),
      routineReserve: async () => ({ status: 'reserved' }), routineRelease: async () => {},
      routineAvailable: async () => true, replay: async () => replayed,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, context({
      sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn',
    }))
    expect(result.success).toBe(true)
    expect(routine).toHaveBeenCalledOnce()
    expect(persisted).toContainEqual(expect.objectContaining({
      phase: 'settled', callId: 'abandoned', result: expect.objectContaining({ success: false }),
    }))
  })

  it('replays a matching routine found by Schedule reconciliation', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const routine = vi.fn(async () => ({ id: 'schedule-new' }))
    const existing = {
      id: 'schedule-existing', kind: 'after', title: 'Daily check', prompt: 'Check the report',
      afterSeconds: 60, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
    }
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine,
      routineReconcile: async () => ({ status: 'committed', record: existing }),
      routineAvailable: async () => true,
      replay: async () => [{
        phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: { title: ' Daily check ', prompt: ' Check the report ', after_seconds: 60 },
      }],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, context({
      sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn',
    }))
    expect(result).toEqual({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(existing) }] })
    expect(routine).not.toHaveBeenCalled()
  })

  it('retires the recovered native routine lifecycle before allowing an intentional repeat', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const persisted: BotDynamicToolEvent[] = []
    const replayed: BotDynamicToolEvent[] = [{
      phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
      arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 },
    }]
    const existing = {
      id: 'schedule-existing', kind: 'after', title: 'Daily check', prompt: 'Check the report',
      afterSeconds: 60, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
    }
    const routine = vi.fn(async () => ({ id: 'schedule-new' }))
    const routineReconcile = vi.fn(async () => ({ status: 'committed' as const, record: existing }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async (event) => { persisted.push(event); replayed.push(event) },
      routine, routineReconcile,
      routineAvailable: async () => true,
      replay: async () => replayed,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    await expect(create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, context({
      sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn',
    }))).resolves.toEqual({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(existing) }] })
    expect(persisted).toContainEqual(expect.objectContaining({
      phase: 'settled', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
    }))
    await expect(create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, context({
      sessionId, callId: 'intentional-repeat', threadId: 'repeat-thread', turnId: 'repeat-turn',
    }))).resolves.toEqual({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ id: 'schedule-new' }) }] })
    expect(routineReconcile).toHaveBeenCalledOnce()
    expect(routine).toHaveBeenCalledOnce()
  })

  it('reconciles equivalent local and UTC absolute routine inputs', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const routine = vi.fn(async () => ({ id: 'schedule-new' }))
    const existing = {
      id: 'schedule-existing', kind: 'at', title: 'Daily check', prompt: 'Check the report',
      scheduledAt: '2099-05-01T09:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
    }
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine,
      routineReconcile: async () => ({ status: 'committed', record: existing }),
      routineAvailable: async () => true,
      replay: async () => [{
        phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: {
          title: 'Daily check', prompt: 'Check the report',
          at: { date: '2099-05-01', time: '09:00:00', time_zone: 'UTC' },
        },
      }],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({
      title: 'Daily check', prompt: 'Check the report', at: '2099-05-01T09:00:00.000Z',
    }, context({ sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn' }))
    expect(result).toEqual({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(existing) }] })
    expect(routine).not.toHaveBeenCalled()
  })

  it('settles both a recovered predecessor and the current retry', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const replayed: BotDynamicToolEvent[] = [
      { phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 } },
      { phase: 'started', name: 'schedule_create', callId: 'retry', threadId: 'new', turnId: 'new', sessionId,
        arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 } },
    ]
    const persisted: BotDynamicToolEvent[] = []
    const existing = {
      id: 'schedule-existing', kind: 'after', title: 'Daily check', prompt: 'Check the report',
      afterSeconds: 60, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
    }
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async (event) => { persisted.push(event); replayed.push(event) },
      routine: vi.fn(async () => ({ id: 'schedule-new' })),
      routineReconcile: async () => ({ status: 'committed', record: existing }),
      routineAvailable: async () => true, replay: async () => replayed,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const retry = context({ sessionId, callId: 'retry', threadId: 'new', turnId: 'new' })
    await expect(create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, retry))
      .resolves.toMatchObject({ success: true })
    expect(persisted.filter(event => event.phase === 'settled').map(event => event.callId))
      .toEqual(['earlier', 'retry'])
    await expect(create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, retry))
      .resolves.toMatchObject({ success: true })
  })

  it('recovers a committed routine after a settled cancellation on a new native key', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const replayed: BotDynamicToolEvent[] = [
      { phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 } },
      { phase: 'settled', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 },
        result: { success: false, contentItems: [{ type: 'inputText', text: '{"error":"cancelled"}' }] } },
    ]
    const routine = vi.fn(async () => ({ id: 'schedule-new' }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async (event) => { replayed.push(event) }, routine,
      routineReconcile: async () => ({ status: 'committed', record: {
        id: 'schedule-existing', kind: 'after', title: 'Daily check', prompt: 'Check the report',
        afterSeconds: 60, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
      } }),
      routineAvailable: async () => true, replay: async () => replayed,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, context({
      sessionId, callId: 'new-call', threadId: 'new-thread', turnId: 'new-turn',
    }))
    expect(result.success).toBe(true)
    expect(routine).not.toHaveBeenCalled()
  })

  it('returns cancellation after synthetic recovery persistence commits', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const replayed: BotDynamicToolEvent[] = [
      { phase: 'started', name: 'schedule_create', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId,
        arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 } },
      { phase: 'started', name: 'schedule_create', callId: 'retry', threadId: 'new', turnId: 'new', sessionId,
        arguments: { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 } },
    ]
    const controller = new AbortController()
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async (event) => {
        replayed.push(event)
        if (event.callId === 'retry') controller.abort()
      },
      routine: vi.fn(async () => ({ id: 'schedule-new' })),
      routineReconcile: async () => ({ status: 'committed', record: {
        id: 'schedule-existing', kind: 'after', title: 'Daily check', prompt: 'Check the report',
        afterSeconds: 60, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
      } }),
      routineAvailable: async () => true, replay: async () => replayed,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }, context({
      sessionId, callId: 'retry', threadId: 'new', turnId: 'new', signal: controller.signal,
    }))
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('cancelled')
    expect(replayed.filter(event => event.phase === 'settled').map(event => event.callId)).toEqual(['earlier', 'retry'])
  })

  it('retries the same call when its native result is missing', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const routine = vi.fn(async (action: string, args: Record<string, unknown>) => ({ action, args }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine,
      routineAvailable: async () => true,
      replay: async () => [{
        phase: 'started', name: 'schedule_create', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId,
        arguments: { title: 'Daily check' },
      }],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check' }, context({ sessionId }))
    expect(result.success).toBe(true)
    expect(routine).toHaveBeenCalledOnce()
  })

  it('retries a settled no-effect failure instead of replaying it forever', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const routine = vi.fn(async () => ({ id: 'schedule-1' }))
    const approval = vi.fn(async () => true)
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine, routineAvailable: async () => true,
      replay: async () => [
        { phase: 'started', name: 'schedule_create', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId, arguments: { title: 'Daily check' } },
        { phase: 'settled', name: 'schedule_create', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId, arguments: { title: 'Daily check' }, result: {
          success: false, contentItems: [{ type: 'inputText' as const, text: '{"error":"approval-denied"}' }],
        } },
      ],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const result = await create.execute({ title: 'Daily check' }, context({ sessionId, requestApproval: approval }))
    expect(result.success).toBe(true)
    expect(approval).toHaveBeenCalledOnce()
    expect(routine).toHaveBeenCalledOnce()
  })

  it('replays a settled routine creation without allocating another schedule id', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const result = { success: true, contentItems: [{ type: 'inputText' as const, text: '{"id":"schedule-1"}' }] }
    const routine = vi.fn(async () => ({ id: 'schedule-2' }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine, routineAvailable: async () => true,
      replay: async () => [
        { phase: 'started', name: 'schedule_create', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId, arguments: { title: 'Daily check' } },
        { phase: 'settled', name: 'schedule_create', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId, arguments: { title: 'Daily check' }, result },
      ],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    await expect(create.execute({ title: 'Daily check' }, context({ sessionId }))).resolves.toEqual(result)
    const conflict = await create.execute({ title: 'Different check' }, context({ sessionId }))
    expect(conflict.success).toBe(false)
    expect(conflict.contentItems[0]?.text).toContain('uncertain-outcome')
    expect(routine).not.toHaveBeenCalled()
  })

  it('allows an intentional identical routine after the earlier call settled', async () => {
    const sessionId = SessionId('bot-session-alpha')
    const result = { success: true, contentItems: [{ type: 'inputText' as const, text: '{"id":"schedule-1"}' }] }
    const routine = vi.fn(async () => ({ id: 'schedule-2' }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, routine, routineAvailable: async () => true,
      replay: async () => [
        { phase: 'started', name: 'schedule_create', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId, arguments: { title: 'Daily check' } },
        { phase: 'settled', name: 'schedule_create', callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', sessionId, arguments: { title: 'Daily check' }, result },
      ],
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const repeated = await create.execute({ title: 'Daily check' }, context({
      sessionId, callId: 'call-2', threadId: 'thread-2', turnId: 'turn-2',
    }))
    expect(repeated.success).toBe(true)
    expect(routine).toHaveBeenCalledOnce()
  })

  it('shares one in-flight schedule creation across parallel retries', async () => {
    const sessionId = SessionId('bot-session-alpha')
    let release: ((value: unknown) => void) | undefined
    const routine = vi.fn(() => new Promise<unknown>((resolve) => { release = resolve }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, replay: async () => [], routine, routineAvailable: async () => true,
    })
    const create = (await provider.resolve({ sessionId })).find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('schedule_create missing')
    const first = create.execute({ title: 'Daily check' }, context({ sessionId }))
    const second = create.execute({ title: 'Daily check' }, context({ sessionId }))
    await Promise.resolve()
    await Promise.resolve()
    expect(routine).toHaveBeenCalledOnce()
    release?.({ id: 'schedule-1' })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true, contentItems: [{ type: 'inputText', text: '{"id":"schedule-1"}' }] },
      { success: true, contentItems: [{ type: 'inputText', text: '{"id":"schedule-1"}' }] },
    ])
  })

  it('does not advertise routines without the scoped capability', async () => {
    const routine = vi.fn(async () => ({ id: 'schedule-1' }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, replay: async () => [], routine,
      routineAvailable: async () => false,
    })
    await expect(provider.resolve({ sessionId: SessionId('bot-session-alpha') })).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'schedule_create' })]),
    )
  })

  it('handles routine cancellation, approval failures, and adapter errors', async () => {
    const routine = vi.fn(async (action: string) => ({ action }))
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, replay: async () => [], routine,
      routineAvailable: async () => true,
    })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const create = tools.find(tool => tool.name === 'schedule_create')
    const update = tools.find(tool => tool.name === 'schedule_update')
    const remove = tools.find(tool => tool.name === 'schedule_delete')
    if (create === undefined || update === undefined || remove === undefined) throw new Error('routine tools missing')

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(create.execute({}, context({ signal: cancelled.signal }))).resolves.toMatchObject({ success: false })
    await expect(create.execute({}, context({ approvalPolicy: 'never' }))).resolves.toMatchObject({ success: false })
    await expect(create.execute({}, context({ requestApproval: async () => { throw new Error('approval unavailable') } })))
      .resolves.toMatchObject({ success: false })
    const approvalThrowCancelled = new AbortController()
    await expect(create.execute({}, context({
      signal: approvalThrowCancelled.signal,
      requestApproval: async () => { approvalThrowCancelled.abort(); throw new Error('approval cancelled') },
    }))).resolves.toMatchObject({ success: false })

    const approvalCancelled = new AbortController()
    await expect(create.execute({}, context({
      signal: approvalCancelled.signal,
      requestApproval: async () => { approvalCancelled.abort(); return true },
    }))).resolves.toMatchObject({ success: false })

    await expect(update.execute({ id: 'routine-1' }, context())).resolves.toMatchObject({ success: true })
    await expect(remove.execute({ id: 'routine-1' }, context())).resolves.toMatchObject({ success: true })

    routine.mockRejectedValueOnce(new BotCollaborationError('message-invalid', 'bad routine'))
    await expect(update.execute({ id: 'routine-1' }, context())).resolves.toMatchObject({ success: false })
    routine.mockRejectedValueOnce(new Error('routine unavailable'))
    await expect(remove.execute({ id: 'routine-1' }, context())).resolves.toMatchObject({ success: false })
  })

  it('returns cancellation when a routine adapter finishes after the signal aborts', async () => {
    const controller = new AbortController()
    const routine = vi.fn(async () => {
      controller.abort()
      return []
    })
    const provider = createBotNativeToolProvider({
      bind: async () => client(), persist: async () => {}, replay: async () => [], routine,
      routineAvailable: async () => true,
    })
    const list = (await provider.resolve({ sessionId: SessionId('bot-session-alpha') })).find(tool => tool.name === 'schedule_list')
    if (list === undefined) throw new Error('schedule_list missing')
    const result = await list.execute({}, context({ signal: controller.signal }))
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('cancelled')
  })

  it('offers bot creation and profile editing actions to a bot', async () => {
    const provider = createBotNativeToolProvider({ bind: async () => client(), persist: async () => {}, replay: async () => [] })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['create_bot', 'edit_bot_profile']))
  })
  it('passes an approved creation request to the Host and preserves cancellation', async () => {
    const manage = vi.fn(async () => ({ id: 'bot-created', name: 'Research' }))
    const provider = createBotNativeToolProvider({ bind: async () => client(), persist: async () => {}, replay: async () => [], manage })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    const create = tools.find(tool => tool.name === 'create_bot')
    if (create === undefined) throw new Error('create_bot missing')
    await expect(create.execute({ name: 'Research' }, context())).resolves.toMatchObject({ success: true })
    expect(manage).toHaveBeenCalledOnce()
    await create.execute({ name: 'Other' }, context({ requestApproval: async () => false }))
    expect(manage).toHaveBeenCalledOnce()
  })
  it('does not create another Bot when an earlier creation has an uncertain outcome', async () => {
    const manage = vi.fn(async () => ({ id: 'bot-created' }))
    const provider = createBotNativeToolProvider({ bind: async () => client(), persist: async () => {}, manage,
      replay: async () => [{ phase: 'started', name: 'create_bot', callId: 'earlier', threadId: 'old', turnId: 'old',
        sessionId: SessionId('bot-session-alpha'), arguments: { name: 'Research' } }] })
    const tool = (await provider.resolve({ sessionId: SessionId('bot-session-alpha') })).find(item => item.name === 'create_bot')!
    const result = await tool.execute({ name: 'Research' }, context())
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toContain('uncertain-outcome')
    expect(manage).not.toHaveBeenCalled()
  })
  it('allows a new creation after checking the roster following an uncertain creation', async () => {
    const manage = vi.fn(async () => ({ id: 'bot-created' }))
    const sessionId = SessionId('bot-session-alpha')
    const provider = createBotNativeToolProvider({ bind: async () => client(), persist: async () => {}, manage,
      replay: async () => [
        { phase: 'started', name: 'create_bot', callId: 'earlier', threadId: 'old', turnId: 'old', sessionId, arguments: { name: 'Research' } },
        { phase: 'settled', name: 'list_bots', callId: 'list', threadId: 'new', turnId: 'new', sessionId, arguments: {},
          result: { success: true, contentItems: [{ type: 'inputText', text: '[]' }] } },
      ] })
    const tool = (await provider.resolve({ sessionId })).find(item => item.name === 'create_bot')!
    expect((await tool.execute({ name: 'Research' }, context())).success).toBe(true)
    expect(manage).toHaveBeenCalledOnce()
  })
  it('binds to the live sender, exposes only collaboration actions, and persists bounded lifecycles', async () => {
    const bound = client()
    const persisted: BotDynamicToolEvent[] = []
    const provider = createBotNativeToolProvider({
      bind: vi.fn(async () => bound), persist: async (event) => { persisted.push(event) }, replay: async () => [],
    })
    const tools = await provider.resolve({ sessionId: SessionId('bot-session-alpha') })
    expect(tools.map(tool => tool.name)).toEqual(['list_bots', 'inspect_bot', 'send_bot_message', 'create_bot', 'edit_bot_profile'])
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
