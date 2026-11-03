import { Context, Service } from '@yharness/cordis'
import { AttachmentId, type ImageAttachmentRef, type StoredImageAttachment } from '@yharness/attachment'
import type { Agent } from '@yharness/agent'
import { createScope } from '@yharness/scope'
import { Session, SessionId } from '@yharness/session'
import type { SessionEvent } from '@yharness/session'
import { createAssistantMessage, createUserMessage, ToolCallId, type UserMessage } from '@yharness/llm'
import Storage from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import type { StorageBackend } from '@yharness/storage'
import SystemPrompt, { renderPrompt } from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import type { ToolExecutionToken, ToolRunContext } from '@yharness/tools'
import { describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScheduleService from '../../../schedule/schedule/src/index.ts'
import { registerScheduleTools } from '../../../schedule/tool-schedule/src/index.ts'
import BotService from '../src/index.ts'
import type { BotDynamicToolEvent } from '../src/collaboration.ts'
import type { BotNativeToolEvent, BotNativeToolProvider } from '../src/native-tools.ts'
import { BotId } from '../src/types.ts'

declare module '@yharness/session' {
  interface TurnEndReasonMap {
    'test/custom': { kind: 'test/custom' }
  }
}

async function harness(
  pool = new MemoryMediaPool(),
  create = vi.fn(async (request: { sessionId?: string }) => ({ sessionId: request.sessionId })),
  readImage = vi.fn(async (ref: ImageAttachmentRef): Promise<StoredImageAttachment> => ({
    ref,
    data: Uint8Array.of(1, 2, 3),
  })),
  existingSessionIds: readonly string[] = [],
  withSchedule = false,
  seedEvents: readonly BotDynamicToolEvent[] = [],
  seedSessionEvents: ReadonlyMap<string, readonly SessionEvent[]> = new Map(),
) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const backend: StorageBackend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  const followups = existingSessionIds.map(() => vi.fn<(message: UserMessage) => void>())
  const pendingFollowups = new Map<string, UserMessage[]>()
  for (const sessionId of existingSessionIds) pendingFollowups.set(sessionId, [])
  const agents = existingSessionIds.map((sessionId, index) => {
    const followup = followups[index]
    if (followup === undefined) throw new Error('test followup was not created')
    const id = SessionId(sessionId)
    const agent: Agent = {
      id,
      options: {},
      session: Session.create(id, seedSessionEvents.get(sessionId)),
      inbox: {
        nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
        replace() { return false }, remove() { return false }, splice() { return [] },
      },
      status: 'idle',
      ctx: new Context(),
      send() {},
      followup,
      steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {},
      cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    const scope = createScope(ctx, agent)
    Object.defineProperty(agent, 'ctx', { value: scope.ctx })
    for (const event of seedEvents.filter(candidate => candidate.sessionId === id)) agent.session.append('bot/dynamic-tool', event)
    return agent
  })
  for (const [index, agent] of agents.entries()) {
    const followup = followups[index]
    if (followup === undefined) throw new Error('test followup was not created')
    followup.mockImplementation((message) => {
      pendingFollowups.get(String(agent.id))?.push(message)
    })
  }
  ctx.provide('agents', {
    get: (sessionId: SessionId) => agents.find(agent => agent.id === sessionId),
    list: () => [...agents],
    withoutInitiator: async <T>(operation: () => Promise<T>) => operation(),
  } as never)
  ctx.provide('attachments', { readImage } as never)
  const inspect = vi.fn(async (sessionId: SessionId) => ({
    events: agents.find(agent => agent.id === sessionId)?.session.snapshotEvents() ?? [],
  }))
  const resolveAgent = vi.fn(async (sessionId: SessionId) => {
    const agent = agents.find(candidate => candidate.id === sessionId)
    return agent === undefined ? { error: new Error('session not found') } : { agent }
  })
  const flush = vi.fn(async (session: Session) => {
    const agent = agents.find(candidate => candidate.session === session)
    if (agent !== undefined) {
      const pending = pendingFollowups.get(String(agent.id)) ?? []
      for (const message of pending) {
        agent.session.append('agent/inbox/spliced', {
          target: 'next-turn', start: 0, inserted: [message],
        })
      }
      pending.length = 0
    }
    return true
  })
  const sessions = {
    get: (sessionId: SessionId) => agents.find(agent => agent.id === sessionId)?.session,
    flush,
  }
  ctx.provide('sessions', sessions as never)
  ctx.provide('sessionController', { create, inspect, resolveAgent } as never)
  ctx.provide('sessionPersistence', {} as never)
  if (withSchedule) await ctx.plugin(ScheduleService)
  if (withSchedule) await Promise.all(agents.map(agent => agent.ctx.inject(
    ['schedule', 'tools'], (scheduleScope: Context) => registerScheduleTools(scheduleScope),
  )))
  const service = new BotService(ctx)
  try {
    await service[Service.init]()
  } catch (error) {
    await close(ctx)
    throw error
  }
  return { ctx, service, pool, create, readImage, agents, inspect, resolveAgent, flush, followups }
}

async function close(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
}

describe('durable Bot roster', () => {
  it('persists an additional character shape across restarts', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Heart bot', identity: 'heart', cwd: '/tmp' })
    await close(first.ctx)
    const reopened = await harness(pool)
    try {
      await expect(reopened.service.list({})).resolves.toMatchObject({ bots: [{ id: created.bot.id, identity: 'heart', sessionId: created.bot.sessionId }] })
    } finally {
      await close(reopened.ctx)
    }
  })
  it('mounts native collaboration actions only for Bot-owned Sessions', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Native bridge owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)])
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      expect(provider).toBeDefined()
      const tools = await provider!.resolve({ sessionId: created.bot.sessionId })
      expect(tools.map(tool => tool.name)).toEqual(['list_bots', 'inspect_bot', 'send_bot_message', 'create_bot', 'edit_bot_profile'])
      const context = {
        callId: 'create-1', threadId: 'thread-1', turnId: 'turn-1', sessionId: created.bot.sessionId,
        signal: new AbortController().signal, approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const create = tools.find(tool => tool.name === 'create_bot')!
      expect((await create.execute({ name: 'Research', identity: 'heart', accent: 'rose' }, context)).success).toBe(true)
      const bots = (await h.service.list({})).bots
      const research = bots.find(bot => bot.name === 'Research')!
      expect(research).toMatchObject({ identity: 'heart', accent: 'rose', cwd: '/tmp' })
      expect((await create.execute({ name: 'Research', identity: 'heart', accent: 'rose' }, context)).success).toBe(true)
      expect((await h.service.list({})).bots.filter(bot => bot.name === 'Research')).toHaveLength(1)
      const edit = tools.find(tool => tool.name === 'edit_bot_profile')!
      expect((await edit.execute({ botId: research.id, name: 'Scout', identity: 'cloud', description: 'Research markets' }, context)).success).toBe(true)
      expect((await h.service.list({})).bots.find(bot => bot.id === research.id)).toMatchObject({
        name: 'Scout', identity: 'cloud', description: 'Research markets', sessionId: research.sessionId,
      })
      const partial = await create.execute({ name: 'Writer', pictureDescription: 'An owl' }, { ...context, callId: 'create-picture' })
      expect(partial.success).toBe(true)
      expect(partial.contentItems[0]?.text).toContain('pictureError')
      expect((await h.service.list({})).bots.filter(bot => bot.name === 'Writer')).toHaveLength(1)
      const avatar: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), mediaType: 'image/png', bytes: 3, width: 64, height: 64,
      }
      const generator = {
        generate: vi.fn(async () => ({ data: 'AQID', mediaType: 'image/png' as const })),
        commit: vi.fn(async () => ({ attachment: avatar })),
      }
      h.ctx.provide('avatarGeneration', generator as never)
      expect((await edit.execute({ botId: research.id, pictureDescription: 'A friendly fox' }, context)).success).toBe(true)
      expect((await h.service.list({})).bots.find(bot => bot.id === research.id)).toMatchObject({ avatar })
      const cancelled = new AbortController()
      generator.generate.mockImplementation(async () => {
        cancelled.abort()
        return { data: 'AQID', mediaType: 'image/png' }
      })
      expect((await edit.execute({ botId: research.id, pictureDescription: 'A cat' }, {
        ...context, signal: cancelled.signal,
      })).success).toBe(false)
      expect(generator.commit).toHaveBeenCalledOnce()
      expect((await h.service.list({})).bots.find(bot => bot.id === research.id)).toMatchObject({ avatar })
      await expect(provider!.resolve({ sessionId: SessionId('ordinary-session') })).resolves.toEqual([])
    } finally {
      await close(h.ctx)
    }
  })

  it('keeps real routine ownership across restart and retires recovered native retries', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Routine owner', cwd: '/tmp' })
    await close(first.ctx)

    const sessionId = created.bot.sessionId
    const h = await harness(pool, undefined, undefined, [String(sessionId)], true)
    let reopened: Awaited<ReturnType<typeof harness>> | undefined
    try {
      const owner = h.agents[0]
      if (owner === undefined) throw new Error('routine owner Agent was not created')
      expect(h.ctx.tools.schemas(owner).filter(tool => tool.name === 'schedule_create')).toHaveLength(1)
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId })
      expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
        'schedule_pause', 'schedule_resume', 'schedule_history',
      ]))
      const create = tools.find(tool => tool.name === 'schedule_create')
      if (create === undefined) throw new Error('schedule_create missing')
      const arguments_ = { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }
      const startedArguments = { title: ' Daily check ', prompt: ' Check the report ', after_seconds: 60 }
      const context = {
        callId: 'routine-create', threadId: 'thread-1', turnId: 'turn-1', sessionId,
        signal: new AbortController().signal, approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const started: BotNativeToolEvent = { phase: 'started', name: 'schedule_create', ...context, arguments: startedArguments }
      await provider.observe(started)
      const result = await create.execute(arguments_, context)
      expect(result.success).toBe(true)
      const firstRecords = await h.ctx.schedule.list({ sessionId })
      expect(firstRecords).toHaveLength(1)
      expect(await h.ctx.schedule.list({ sessionId: SessionId('other-session') })).toEqual([])
      // The native result is intentionally not settled. Schedule reconciliation
      // resolves the prior durable create before the new call can retry it.
      const newCallContext = {
        ...context, callId: 'routine-new-call', threadId: 'thread-new', turnId: 'turn-new',
      }
      const duplicate = await create.execute(arguments_, newCallContext)
      expect(duplicate.success).toBe(true)
      expect(await h.ctx.schedule.list({ sessionId })).toHaveLength(1)
      const serviceCancelled = new AbortController()
      serviceCancelled.abort()
      await expect(h.ctx.schedule.create(sessionId, arguments_, serviceCancelled.signal)).rejects.toThrow()
      expect(await h.ctx.schedule.list({ sessionId })).toHaveLength(1)
      const durableEvents = h.agents[0]!.session.snapshotEvents()
        .flatMap(event => event.type === 'bot/dynamic-tool' ? [event.data] : [])
      await close(h.ctx)

      reopened = await harness(pool, undefined, undefined, [String(sessionId)], true, durableEvents)
      const providerAfterRestart = reopened.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (providerAfterRestart === undefined) throw new Error('restarted Bot provider was not mounted')
      const toolsAfterRestart = await providerAfterRestart.resolve({ sessionId })
      const createAfterRestart = toolsAfterRestart.find(tool => tool.name === 'schedule_create')
      if (createAfterRestart === undefined) throw new Error('restarted schedule_create missing')
      const sameCall = await createAfterRestart.execute(arguments_, context)
      expect(sameCall).toEqual(result)
      const replayed = await createAfterRestart.execute(arguments_, newCallContext)
      expect(replayed.success).toBe(true)
      expect(await reopened.ctx.schedule.list({ sessionId })).toHaveLength(2)

      const cancelled = new AbortController()
      cancelled.abort()
      const cancelledResult = await createAfterRestart.execute(arguments_, {
        ...context, callId: 'routine-cancelled', signal: cancelled.signal,
      })
      expect(cancelledResult.success).toBe(false)
      expect(cancelledResult.contentItems[0]?.text).toContain('cancelled')
      expect(await reopened.ctx.schedule.list({ sessionId })).toHaveLength(2)
    } finally {
      if (reopened !== undefined) await close(reopened.ctx)
      else await close(h.ctx)
    }
  })

  it('executes Bot-scoped pause, resume, and delivery-history actions through the real Schedule service', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Routine lifecycle owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const context = {
        callId: 'routine-lifecycle', threadId: 'thread-lifecycle', turnId: 'turn-lifecycle',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const create = tools.find(tool => tool.name === 'schedule_create')
      const update = tools.find(tool => tool.name === 'schedule_update')
      const pause = tools.find(tool => tool.name === 'schedule_pause')
      const resume = tools.find(tool => tool.name === 'schedule_resume')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || update === undefined || pause === undefined || resume === undefined || history === undefined) {
        throw new Error('Bot routine lifecycle tools were not mounted')
      }
      const createdRoutine = await create.execute({ title: 'Status check', prompt: 'Check status', every_seconds: 300 }, context)
      expect(createdRoutine.success).toBe(true)
      const routineId = JSON.parse(createdRoutine.contentItems[0]!.text).id as string
      const paused = await pause.execute({ id: routineId }, { ...context, callId: 'pause-routine' })
      expect(paused).toMatchObject({ success: true })
      expect(await h.ctx.schedule.catalog()).toEqual([expect.objectContaining({ id: routineId, status: 'paused' })])
      const edited = await update.execute({ id: routineId, title: 'Updated status check', prompt: 'Check updated status' }, {
        ...context, callId: 'update-paused-routine', requestApproval: async () => true,
      })
      expect(edited).toMatchObject({ success: true })
      expect(await h.ctx.schedule.catalog()).toEqual([expect.objectContaining({
        id: routineId, status: 'paused', title: 'Updated status check', prompt: 'Check updated status',
      })])
      const resumed = await resume.execute({ id: routineId }, { ...context, callId: 'resume-routine' })
      expect(resumed).toMatchObject({ success: true })
      expect(await h.ctx.schedule.catalog()).toEqual([expect.objectContaining({ id: routineId, status: 'active' })])
      const deliveries = await history.execute({ id: routineId, limit: 10 }, { ...context, callId: 'history-routine' })
      expect(deliveries).toMatchObject({ success: true })
      expect(JSON.parse(deliveries.contentItems[0]!.text)).toMatchObject({ id: routineId, records: [] })

      const unsupported = await create.execute({
        title: 'Event check', prompt: 'Watch an event', event: { source: 'webhook' },
      }, { ...context, callId: 'unsupported-event' })
      expect(unsupported).toMatchObject({ success: false })
      expect(unsupported.contentItems[0]?.text).toContain('A routine event must be')
      const unsupportedUpdate = await update.execute({
        id: routineId, event: { source: 'webhook' },
      }, { ...context, callId: 'unsupported-event-update' })
      expect(unsupportedUpdate).toMatchObject({ success: false })
      expect(unsupportedUpdate.contentItems[0]?.text).toContain('A routine event must be')
    } finally {
      await close(h.ctx)
    }
  })

  it('creates a Bot message-triggered routine and records its model result', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Event routine owner', cwd: '/tmp' })
    const peer = await first.service.create({ name: 'Event routine peer', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId), String(peer.bot.sessionId)], true)
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      const list = tools.find(tool => tool.name === 'schedule_list')
      const update = tools.find(tool => tool.name === 'schedule_update')
      const pause = tools.find(tool => tool.name === 'schedule_pause')
      const resume = tools.find(tool => tool.name === 'schedule_resume')
      const remove = tools.find(tool => tool.name === 'schedule_delete')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || list === undefined || update === undefined || pause === undefined
        || resume === undefined || remove === undefined || history === undefined) throw new Error('event routine tools missing')
      const context = {
        callId: 'event-create', threadId: 'event-thread', turnId: 'event-turn',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const result = await create.execute({
        title: 'Review bot messages', prompt: 'Review the latest message and summarize it.',
        event: { type: 'message', source: 'bot' },
      }, context)
      expect(result.success).toBe(true)
      const routine = JSON.parse(result.contentItems[0]!.text) as { id: string; kind: string }
      expect(routine.kind).toBe('event')
      expect(routine).not.toHaveProperty('deliveries')
      expect(routine).not.toHaveProperty('results')
      expect((await h.service.list({})).bots.find(bot => bot.id === created.bot.id)).not.toHaveProperty('eventRoutines')
      expect(await update.execute({ id: routine.id, title: 'Review peer messages' }, { ...context, callId: 'event-update' })).toMatchObject({ success: true })
      expect(await pause.execute({ id: routine.id }, { ...context, callId: 'event-pause' })).toMatchObject({ success: true })
      expect(await resume.execute({ id: routine.id }, { ...context, callId: 'event-resume' })).toMatchObject({ success: true })
      const listed = await list.execute({}, { ...context, callId: 'event-list' })
      expect(listed).toMatchObject({ success: true })
      const listedValue = JSON.parse(listed.contentItems[0]!.text) as readonly Record<string, unknown>[]
      expect(listedValue[0]).not.toHaveProperty('deliveries')
      expect(listedValue[0]).not.toHaveProperty('results')

      const owner = h.agents[0]
      if (owner === undefined) throw new Error('event routine owner Agent was not created')
      const followup = h.followups[0]
      if (followup === undefined) throw new Error('event routine follow-up was not created')
      expect(h.ctx.tools.schemas(owner).map(tool => tool.name)).toEqual(expect.arrayContaining([
        'schedule_event_create', 'schedule_event_list', 'schedule_event_update', 'schedule_event_delete',
        'schedule_event_pause', 'schedule_event_resume', 'schedule_event_history',
      ]))
      const scopedCreate = h.ctx.tools.get('schedule_event_create', owner)
      if (scopedCreate === undefined) throw new Error('scoped event routine create tool missing')
      const scopedCallId = ToolCallId('scoped-event-create')
      const scopedExecution: ToolRunContext = {
        callId: scopedCallId, rootCallId: scopedCallId, name: 'schedule_event_create',
        arguments: {}, agent: owner, signal: new AbortController().signal,
        token: Symbol('scoped-event-create') as ToolExecutionToken,
        deferContext: () => {}, concludeTurn: () => {},
      }
      const scopedRoutine = await scopedCreate.execute({
        title: 'User-facing digest', prompt: 'Summarize direct user messages.',
        event: { type: 'message', source: 'user' },
      }, scopedExecution)
      expect(scopedRoutine).toMatchObject({ kind: 'event', state: 'waiting' })
      owner.session.append('turn/start', { turn: 1 })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'A peer bot sent this.' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: peer.bot.sessionId },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(() => {
        expect(followup).toHaveBeenCalledOnce()
      })
      const triggeredCall = followup.mock.calls.at(0)
      if (triggeredCall === undefined) throw new Error('event routine follow-up was not captured')
      const triggered = triggeredCall[0]
      owner.session.append('turn/start', { turn: 2 })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('user/message', triggered, { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('assistant/message', {
        turn: 2, step: 0,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'Peer message reviewed.' }], source: { provider: 'test', model: 'test-model' } }),
        stream: [],
      }, { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(async () => {
        const execution = await history.execute({ id: routine.id, limit: 10 }, { ...context, callId: 'event-history' })
        expect(execution).toMatchObject({ success: true })
        const value = JSON.parse(execution.contentItems[0]!.text) as { results: readonly { status: string; output?: string }[] }
        expect(value.results).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed', output: 'Peer message reviewed.' })]))
      })
      expect(await remove.execute({ id: routine.id }, { ...context, callId: 'event-delete' })).toMatchObject({ success: true })
    } finally {
      await close(h.ctx)
    }
  })

  it('attributes event-routine results only after the follow-up is claimed', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Active-turn routine owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || history === undefined) throw new Error('event routine tools missing')
      const context = {
        callId: 'active-turn-create', threadId: 'active-turn-thread', turnId: 'active-turn-create-turn',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const result = await create.execute({
        title: 'Active turn monitor', prompt: 'Review the next message.',
        event: { type: 'message', source: 'user' },
      }, context)
      expect(result.success).toBe(true)
      const routine = JSON.parse(result.contentItems[0]!.text) as { id: string }
      const owner = h.agents[0]
      const followup = h.followups[0]
      if (owner === undefined || followup === undefined) throw new Error('event routine owner was not created')

      owner.session.append('turn/start', { turn: 1 })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      const canceled = createUserMessage({ content: [{ type: 'text', text: 'Canceled before claim.' }], source: { kind: 'user' } })
      owner.session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [canceled],
      })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await Promise.resolve()
      expect(followup).not.toHaveBeenCalled()

      owner.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Start the routine.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(() => {
        expect(followup).toHaveBeenCalledOnce()
      })
      const triggered = followup.mock.calls[0]?.[0]
      if (triggered === undefined) throw new Error('event routine follow-up was not captured')
      owner.session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [triggered],
      })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('assistant/message', {
        turn: 1, step: 0,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'Previous turn output.' }], source: { provider: 'test', model: 'test-model' } }),
        stream: [],
      }, { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(async () => {
        const beforeClaim = await history.execute({ id: routine.id, limit: 10 }, { ...context, callId: 'active-turn-before-claim' })
        const value = JSON.parse(beforeClaim.contentItems[0]!.text) as { results: readonly unknown[] }
        expect(value.results).toEqual([])
      })

      owner.session.append('turn/start', { turn: 2 })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('user/message', triggered, { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('assistant/message', {
        turn: 2, step: 0,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'Claimed follow-up output.' }], source: { provider: 'test', model: 'test-model' } }),
        stream: [],
      }, { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      owner.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(async () => {
        const afterClaim = await history.execute({ id: routine.id, limit: 10 }, { ...context, callId: 'active-turn-after-claim' })
        const value = JSON.parse(afterClaim.contentItems[0]!.text) as { results: readonly { output?: string }[] }
        expect(value.results).toEqual(expect.arrayContaining([expect.objectContaining({ output: 'Claimed follow-up output.' })]))
      })
    } finally {
      await close(h.ctx)
    }
  })

  it('replays a pending event delivery after a Host restart without duplicating it', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Pending event owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    let reopened: Awaited<ReturnType<typeof harness>> | undefined
    let initialClosed = false
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || history === undefined) throw new Error('event routine tools missing')
      const context = {
        callId: 'pending-event-create', threadId: 'pending-event-thread', turnId: 'pending-event-turn',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const result = await create.execute({
        title: 'User message monitor', prompt: 'Review the latest user message.',
        event: { type: 'message', source: 'user' },
      }, context)
      expect(result.success).toBe(true)
      const routine = JSON.parse(result.contentItems[0]!.text) as { id: string }

      h.flush.mockResolvedValueOnce(false)
      const owner = h.agents[0]
      if (owner === undefined) throw new Error('event routine owner Agent was not created')
      const followup = h.followups[0]
      if (followup === undefined) throw new Error('event routine follow-up was not created')
      owner.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'A direct user message.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(() => {
        expect(followup).toHaveBeenCalledOnce()
      })
      const pendingMessage = followup.mock.calls[0]?.[0]
      if (pendingMessage === undefined) throw new Error('pending event message was not captured')
      owner.session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [pendingMessage],
      })
      const pending = await history.execute({ id: routine.id, limit: 10 }, { ...context, callId: 'pending-event-history' })
      expect(JSON.parse(pending.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'pending' }] })
      await close(h.ctx)
      initialClosed = true

      reopened = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true, [], new Map([
        [String(created.bot.sessionId), owner.session.snapshotEvents()],
      ]))
      expect(reopened.followups[0]).not.toHaveBeenCalled()
      expect(reopened.flush).toHaveBeenCalled()
      const reopenedProvider = reopened.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (reopenedProvider === undefined) throw new Error('reopened native Bot provider was not mounted')
      const reopenedHistory = (await reopenedProvider.resolve({ sessionId: created.bot.sessionId })).find(tool => tool.name === 'schedule_history')
      if (reopenedHistory === undefined) throw new Error('reopened schedule_history missing')
      const recovered = await reopenedHistory.execute({ id: routine.id, limit: 10 }, { ...context, callId: 'recovered-event-history' })
      expect(JSON.parse(recovered.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'delivered' }] })
    } finally {
      if (reopened !== undefined) await close(reopened.ctx)
      else if (!initialClosed) await close(h.ctx)
    }
  })

  it('does not redispatch after an uncertain follow-up without a Session receipt', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Uncertain delivery owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    let reopened: Awaited<ReturnType<typeof harness>> | undefined
    let initialClosed = false
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || history === undefined) throw new Error('event routine tools missing')
      const context = {
        callId: 'uncertain-create', threadId: 'uncertain-thread', turnId: 'uncertain-turn',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const result = await create.execute({
        title: 'Uncertain monitor', prompt: 'Review the next user message.',
        event: { type: 'message', source: 'user' },
      }, context)
      expect(result.success).toBe(true)
      const routine = JSON.parse(result.contentItems[0]!.text) as { id: string }
      const owner = h.agents[0]
      const followup = h.followups[0]
      if (owner === undefined || followup === undefined) throw new Error('event routine owner was not created')
      h.flush.mockResolvedValueOnce(false)
      owner.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Trigger before the Host loses its receipt.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })
      const pendingMessage = followup.mock.calls[0]?.[0]
      if (pendingMessage === undefined) throw new Error('uncertain event follow-up was not captured')
      const seed = owner.session.snapshotEvents()
      await close(h.ctx)
      initialClosed = true

      reopened = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true, [], new Map([
        [String(created.bot.sessionId), seed],
      ]))
      expect(reopened.followups[0]).not.toHaveBeenCalled()
      expect(reopened.flush).not.toHaveBeenCalled()
      const reopenedProvider = reopened.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (reopenedProvider === undefined) throw new Error('reopened native Bot provider was not mounted')
      const reopenedTools = await reopenedProvider.resolve({ sessionId: created.bot.sessionId })
      const reopenedHistory = reopenedTools.find(tool => tool.name === 'schedule_history')
      if (reopenedHistory === undefined) throw new Error('reopened schedule_history missing')
      const stillPending = await reopenedHistory.execute({ id: routine.id, limit: 1 }, { ...context, callId: 'uncertain-pending' })
      expect(JSON.parse(stillPending.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'pending' }] })

      reopened.agents[0]!.session.append('user/message', pendingMessage, { surfaceOp: 'append' })
      reopened.ctx.emit('session/event', reopened.agents[0]!.session, reopened.agents[0]!.session.snapshotEvents().at(-1)!)
      await vi.waitFor(async () => {
        const claimed = await reopenedHistory.execute({ id: routine.id, limit: 1 }, { ...context, callId: 'uncertain-claimed' })
        expect(JSON.parse(claimed.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'delivered' }] })
      })
      expect(reopened.followups[0]).not.toHaveBeenCalled()
    } finally {
      if (reopened !== undefined) await close(reopened.ctx)
      else if (!initialClosed) await close(h.ctx)
    }
  })

  it('retries an event routine after its inbox message was canceled', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Canceled delivery owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    let reopened: Awaited<ReturnType<typeof harness>> | undefined
    let initialClosed = false
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || history === undefined) throw new Error('event routine tools missing')
      const context = {
        callId: 'canceled-create', threadId: 'canceled-thread', turnId: 'canceled-turn',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const result = await create.execute({
        title: 'Canceled monitor', prompt: 'Review the next user message.',
        event: { type: 'message', source: 'user' },
      }, context)
      expect(result.success).toBe(true)
      const routine = JSON.parse(result.contentItems[0]!.text) as { id: string }
      const owner = h.agents[0]
      const followup = h.followups[0]
      if (owner === undefined || followup === undefined) throw new Error('event routine owner was not created')
      let ownerInspections = 0
      h.inspect.mockImplementation(async (sessionId) => {
        const events = h.agents.find(agent => agent.id === sessionId)?.session.snapshotEvents() ?? []
        ownerInspections += 1
        if (String(sessionId) === String(owner.id) && ownerInspections === 3) {
          queueMicrotask(() => {
            owner.session.append('agent/inbox/spliced', {
              target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
            })
            h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
          })
        }
        return { events: [...events] }
      })
      h.flush.mockImplementationOnce(async () => {
        const pendingMessage = followup.mock.calls[0]?.[0]
        if (pendingMessage === undefined) throw new Error('canceled event follow-up was not captured before flush')
        owner.session.append('agent/inbox/spliced', {
          target: 'next-turn', start: 0, inserted: [pendingMessage],
        })
        return true
      })
      owner.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Trigger the canceled delivery.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })
      await vi.waitFor(async () => {
        const recovered = await history.execute({ id: routine.id, limit: 1 }, { ...context, callId: 'canceled-before-restart' })
        expect(JSON.parse(recovered.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'delivered' }] })
      })
      const seed = owner.session.snapshotEvents()
      await close(h.ctx)
      initialClosed = true

      reopened = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true, [], new Map([
        [String(created.bot.sessionId), seed],
      ]))
      expect(reopened.followups[0]).not.toHaveBeenCalled()
      expect(reopened.flush).not.toHaveBeenCalled()
      const reopenedProvider = reopened.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (reopenedProvider === undefined) throw new Error('reopened native Bot provider was not mounted')
      const reopenedHistory = (await reopenedProvider.resolve({ sessionId: created.bot.sessionId })).find(tool => tool.name === 'schedule_history')
      if (reopenedHistory === undefined) throw new Error('reopened schedule_history missing')
      const recovered = await reopenedHistory.execute({ id: routine.id, limit: 1 }, { ...context, callId: 'canceled-after-restart' })
      expect(JSON.parse(recovered.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'delivered' }] })
    } finally {
      if (reopened !== undefined) await close(reopened.ctx)
      else if (!initialClosed) await close(h.ctx)
    }
  })

  it('reconstructs event-routine result attribution from persisted turns after restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Result recovery owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    let reopened: Awaited<ReturnType<typeof harness>> | undefined
    let initialClosed = false
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || history === undefined) throw new Error('event routine tools missing')
      const context = {
        callId: 'result-recovery-create', threadId: 'result-recovery-thread', turnId: 'result-recovery-turn',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const result = await create.execute({
        title: 'Persist results', prompt: 'Summarize the event.', event: { type: 'message', source: 'user' },
      }, context)
      expect(result.success).toBe(true)
      const routine = JSON.parse(result.contentItems[0]!.text) as { id: string }
      const owner = h.agents[0]
      if (owner === undefined) throw new Error('event routine owner was not created')
      owner.session.append('turn/start', { turn: 7 })
      const routineMessage = createUserMessage({
        content: [{ type: 'text', text: '[BOT EVENT ROUTINE]\nPersist this.' }],
        source: {
          kind: 'bot-event-routine', form: 'notice', summary: 'Routine triggered', routineId: routine.id,
          triggerEventSeq: 3, chainId: 'result-recovery-chain', depth: 0,
        },
      })
      owner.session.append('user/message', routineMessage, { surfaceOp: 'append' })
      owner.session.append('assistant/message', {
        turn: 7, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'Recovered result.' }],
          source: { provider: 'test', model: 'test-model' },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      owner.session.append('turn/end', { turn: 7, reason: { kind: 'test/custom' } })
      const seed = owner.session.snapshotEvents()
      await close(h.ctx)
      initialClosed = true

      reopened = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true, [], new Map([
        [String(created.bot.sessionId), seed],
      ]))
      const reopenedProvider = reopened.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (reopenedProvider === undefined) throw new Error('reopened native Bot provider was not mounted')
      const reopenedHistory = (await reopenedProvider.resolve({ sessionId: created.bot.sessionId })).find(tool => tool.name === 'schedule_history')
      if (reopenedHistory === undefined) throw new Error('reopened schedule_history missing')
      await vi.waitFor(async () => {
        const recovered = await reopenedHistory.execute({ id: routine.id, limit: 1 }, { ...context, callId: 'result-recovery-history' })
        expect(JSON.parse(recovered.contentItems[0]!.text)).toMatchObject({
          results: [{ status: 'other', output: 'Recovered result.' }],
        })
      })
    } finally {
      if (reopened !== undefined) await close(reopened.ctx)
      else if (!initialClosed) await close(h.ctx)
    }
  })

  it('limits cross-Bot event-routine relays and ignores non-Bot agent messages', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const sender = await first.service.create({ name: 'Relay sender', cwd: '/tmp' })
    const target = await first.service.create({ name: 'Relay target', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [
      String(sender.bot.sessionId), String(target.bot.sessionId),
    ], true)
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const senderTools = await provider.resolve({ sessionId: sender.bot.sessionId })
      const targetTools = await provider.resolve({ sessionId: target.bot.sessionId })
      const senderCreate = senderTools.find(tool => tool.name === 'schedule_create')
      const targetCreate = targetTools.find(tool => tool.name === 'schedule_create')
      if (senderCreate === undefined || targetCreate === undefined) throw new Error('event routine tools missing')
      const context = (sessionId: SessionId, prefix: string) => ({
        callId: `${prefix}-create`, threadId: `${prefix}-thread`, turnId: `${prefix}-turn`, sessionId,
        signal: new AbortController().signal, approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      })
      const senderRoutineResult = await senderCreate.execute({
        title: 'Relay sender routine', prompt: 'Handle peer messages.', event: { type: 'message', source: 'bot' },
      }, context(sender.bot.sessionId, 'sender'))
      const targetRoutineResult = await targetCreate.execute({
        title: 'Relay target routine', prompt: 'Handle peer messages.', event: { type: 'message', source: 'bot' },
      }, context(target.bot.sessionId, 'target'))
      expect(senderRoutineResult.success).toBe(true)
      expect(targetRoutineResult.success).toBe(true)
      const senderRoutine = JSON.parse(senderRoutineResult.contentItems[0]!.text) as { id: string }
      const targetRoutine = JSON.parse(targetRoutineResult.contentItems[0]!.text) as { id: string }
      const senderAgent = h.agents[0]
      const targetAgent = h.agents[1]
      const senderFollowup = h.followups[0]
      const targetFollowup = h.followups[1]
      if (senderAgent === undefined || targetAgent === undefined || senderFollowup === undefined || targetFollowup === undefined) {
        throw new Error('relay Bot agents were not created')
      }

      senderAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Start the relay.' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: target.bot.sessionId },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', senderAgent.session, senderAgent.session.snapshotEvents().at(-1)!)
      await vi.waitFor(() => { expect(senderFollowup).toHaveBeenCalledOnce() })
      const senderRoutineMessage = senderFollowup.mock.calls[0]?.[0]
      if (senderRoutineMessage === undefined) throw new Error('sender routine message was not captured')

      senderAgent.session.append('turn/start', { turn: 2 })
      h.ctx.emit('session/event', senderAgent.session, senderAgent.session.snapshotEvents().at(-1)!)
      await new Promise(resolve => setTimeout(resolve, 0))
      senderAgent.session.append('user/message', senderRoutineMessage, { surfaceOp: 'append' })
      h.ctx.emit('session/event', senderAgent.session, senderAgent.session.snapshotEvents().at(-1)!)
      const senderClient = await h.service.collaborationFor(senderAgent)
      await senderClient.send({ targetBotId: target.bot.id, text: 'Please process this relay.' })
      const targetRelayMessage = targetFollowup.mock.calls[0]?.[0]
      if (targetRelayMessage === undefined) throw new Error('target relay message was not captured')
      expect(targetRelayMessage.source).toMatchObject({
        kind: 'agent-message', botEventRoutine: { depth: 1 },
      })

      const targetClient = await h.service.collaborationFor(targetAgent)
      targetAgent.session.append('turn/start', { turn: 1 })
      h.ctx.emit('session/event', targetAgent.session, targetAgent.session.snapshotEvents().at(-1)!)
      targetAgent.session.append('user/message', targetRelayMessage, { surfaceOp: 'append' })
      h.ctx.emit('session/event', targetAgent.session, targetAgent.session.snapshotEvents().at(-1)!)
      await targetClient.send({ targetBotId: sender.bot.id, text: 'A direct reply from this peer turn.' })
      const directReply = senderFollowup.mock.calls.at(-1)?.[0]
      if (directReply === undefined) throw new Error('direct relay reply was not captured')
      expect(directReply.source).toMatchObject({
        kind: 'agent-message', botEventRoutine: { depth: 2 },
      })
      await vi.waitFor(() => { expect(targetFollowup).toHaveBeenCalledTimes(2) })
      const targetRoutineMessage = targetFollowup.mock.calls.at(-1)?.[0]
      if (targetRoutineMessage === undefined) throw new Error('target routine message was not captured')

      targetAgent.session.append('turn/start', { turn: 2 })
      h.ctx.emit('session/event', targetAgent.session, targetAgent.session.snapshotEvents().at(-1)!)
      await new Promise(resolve => setTimeout(resolve, 0))
      targetAgent.session.append('user/message', targetRoutineMessage, { surfaceOp: 'append' })
      h.ctx.emit('session/event', targetAgent.session, targetAgent.session.snapshotEvents().at(-1)!)
      await targetClient.send({ targetBotId: sender.bot.id, text: 'The relay continued.' })
      await vi.waitFor(() => { expect(senderFollowup).toHaveBeenCalledTimes(3) })

      senderAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Ignore this subagent.' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('subagent-session') },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', senderAgent.session, senderAgent.session.snapshotEvents().at(-1)!)
      senderAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Stop the relay.' }],
        source: {
          kind: 'agent-message', form: 'relay', senderSessionId: target.bot.sessionId,
          botEventRoutine: { chainId: 'relay-loop', depth: 4 },
        },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', senderAgent.session, senderAgent.session.snapshotEvents().at(-1)!)
      await new Promise(resolve => setTimeout(resolve, 0))
      await senderClient.send({ targetBotId: target.bot.id, text: 'Do not relay this capped message.' })
      const cappedReply = targetFollowup.mock.calls.at(-1)?.[0]
      if (cappedReply === undefined) throw new Error('capped relay reply was not captured')
      expect(cappedReply.source).toMatchObject({
        kind: 'agent-message', botEventRoutine: { depth: 4 },
      })
      expect(targetFollowup).toHaveBeenCalledTimes(3)
      expect(senderFollowup).toHaveBeenCalledTimes(3)
      void senderRoutine
      void targetRoutine
    } finally {
      await close(h.ctx)
    }
  })

  it('reconstructs capped peer relay depth from an unobserved persisted turn', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const owner = await first.service.create({ name: 'Persisted relay owner', cwd: '/tmp' })
    const peer = await first.service.create({ name: 'Persisted relay peer', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [
      String(owner.bot.sessionId), String(peer.bot.sessionId),
    ], true)
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: owner.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      if (create === undefined) throw new Error('event routine create tool missing')
      const routine = await create.execute({
        title: 'Persist relay context', prompt: 'Handle peer messages.', event: { type: 'message', source: 'bot' },
      }, {
        callId: 'persisted-relay-create', threadId: 'persisted-relay-thread', turnId: 'persisted-relay-turn',
        sessionId: owner.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      })
      expect(routine.success).toBe(true)
      const ownerAgent = h.agents[0]
      if (ownerAgent === undefined) throw new Error('persisted relay owner Agent was not created')
      ownerAgent.session.append('turn/start', { turn: 9 })
      ownerAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'A lower-depth peer relay.' }],
        source: {
          kind: 'agent-message', form: 'relay', senderSessionId: peer.bot.sessionId,
          botEventRoutine: { chainId: 'persisted-relay-chain', depth: 1 },
        },
      }), { surfaceOp: 'append' })
      ownerAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'A capped peer relay.' }],
        source: {
          kind: 'agent-message', form: 'relay', senderSessionId: peer.bot.sessionId,
          botEventRoutine: { chainId: 'persisted-relay-chain', depth: 4 },
        },
      }), { surfaceOp: 'append' })
      const client = await h.service.collaborationFor(ownerAgent)
      await client.send({ targetBotId: peer.bot.id, text: 'Keep the capped relay depth.' })
      const peerMessage = h.followups[1]?.mock.calls[0]?.[0]
      if (peerMessage === undefined) throw new Error('persisted relay message was not captured')
      expect(peerMessage.source).toMatchObject({
        kind: 'agent-message', botEventRoutine: { chainId: 'persisted-relay-chain', depth: 4 },
      })
    } finally {
      await close(h.ctx)
    }
  })

  it('does not recover paused deliveries and retries them when resumed', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Paused event owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    let reopened: Awaited<ReturnType<typeof harness>> | undefined
    let initialClosed = false
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const tools = await provider.resolve({ sessionId: created.bot.sessionId })
      const create = tools.find(tool => tool.name === 'schedule_create')
      const pause = tools.find(tool => tool.name === 'schedule_pause')
      const history = tools.find(tool => tool.name === 'schedule_history')
      if (create === undefined || pause === undefined || history === undefined) throw new Error('event routine tools missing')
      const context = {
        callId: 'paused-event-create', threadId: 'paused-event-thread', turnId: 'paused-event-turn',
        sessionId: created.bot.sessionId, signal: new AbortController().signal,
        approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const result = await create.execute({
        title: 'Paused monitor', prompt: 'Review the latest user message.',
        event: { type: 'message', source: 'user' },
      }, context)
      expect(result.success).toBe(true)
      const routine = JSON.parse(result.contentItems[0]!.text) as { id: string }
      h.flush.mockResolvedValueOnce(false)
      const owner = h.agents[0]
      const followup = h.followups[0]
      if (owner === undefined || followup === undefined) throw new Error('event routine owner was not created')
      owner.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Pause before retry.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      h.ctx.emit('session/event', owner.session, owner.session.snapshotEvents().at(-1)!)
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })
      expect(await pause.execute({ id: routine.id }, { ...context, callId: 'paused-event-pause' })).toMatchObject({ success: true })
      const pending = await history.execute({ id: routine.id, limit: 1 }, { ...context, callId: 'paused-event-history' })
      expect(JSON.parse(pending.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'pending' }] })
      await close(h.ctx)
      initialClosed = true

      reopened = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
      expect(reopened.followups[0]).not.toHaveBeenCalled()
      const reopenedProvider = reopened.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (reopenedProvider === undefined) throw new Error('reopened native Bot provider was not mounted')
      const reopenedTools = await reopenedProvider.resolve({ sessionId: created.bot.sessionId })
      const resume = reopenedTools.find(tool => tool.name === 'schedule_resume')
      const reopenedHistory = reopenedTools.find(tool => tool.name === 'schedule_history')
      if (resume === undefined || reopenedHistory === undefined) throw new Error('reopened event routine tools missing')
      expect(await resume.execute({ id: routine.id }, { ...context, callId: 'paused-event-resume' })).toMatchObject({ success: true })
      await vi.waitFor(() => { expect(reopened.followups[0]).toHaveBeenCalledOnce() })
      expect(reopened.flush).toHaveBeenCalled()
      const recovered = await reopenedHistory.execute({ id: routine.id, limit: 1 }, { ...context, callId: 'paused-event-recovered' })
      expect(JSON.parse(recovered.contentItems[0]!.text)).toMatchObject({ deliveries: [{ status: 'delivered' }] })
    } finally {
      if (reopened !== undefined) await close(reopened.ctx)
      else if (!initialClosed) await close(h.ctx)
    }
  })

  it('does not reconcile a routine before its first approval reaches Schedule', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Approval owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)], true)
    try {
      const owner = h.agents[0]
      if (owner === undefined) throw new Error('routine owner Agent was not created')
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native Bot provider was not mounted')
      const create = (await provider.resolve({ sessionId: created.bot.sessionId })).find(tool => tool.name === 'schedule_create')
      if (create === undefined) throw new Error('schedule_create missing')
      const arguments_ = { title: 'Daily check', prompt: 'Check the report', after_seconds: 60 }
      const approval = Promise.withResolvers<boolean>()
      const approvalRequested = Promise.withResolvers<true>()
      const firstContext = {
        callId: 'approval-first', threadId: 'approval-thread', turnId: 'approval-turn', sessionId: created.bot.sessionId,
        signal: new AbortController().signal, approvalPolicy: 'on-request' as const,
        requestApproval: async () => { approvalRequested.resolve(true); return approval.promise },
      }
      await provider.observe({ phase: 'started', name: 'schedule_create', ...firstContext, arguments: arguments_ })
      const firstCall = create.execute(arguments_, firstContext)
      await approvalRequested.promise
      const second = await create.execute(arguments_, {
        ...firstContext, callId: 'approval-second', threadId: 'approval-second-thread', turnId: 'approval-second-turn',
        requestApproval: async () => true,
      })
      expect(second.success).toBe(false)
      expect(second.contentItems[0]?.text).toContain('uncertain-outcome')
      expect(await h.ctx.schedule.list({ sessionId: created.bot.sessionId })).toEqual([])
      approval.resolve(true)
      await expect(firstCall).resolves.toMatchObject({ success: true })
      expect(await h.ctx.schedule.list({ sessionId: created.bot.sessionId })).toHaveLength(1)
    } finally {
      await close(h.ctx)
    }
  })

  it('binds collaboration to a Bot Agent and flushes explicit peer delivery', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const sender = await first.service.create({ name: 'Sender', cwd: '/tmp' })
    const target = await first.service.create({ name: 'Target', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [
      String(sender.bot.sessionId), String(target.bot.sessionId),
    ])
    try {
      const senderAgent = h.agents[0]
      const targetAgent = h.agents[1]
      const targetFollowup = h.followups[1]
      if (senderAgent === undefined) throw new Error('sender test Agent was not created')
      if (targetAgent === undefined) throw new Error('target test Agent was not created')
      if (targetFollowup === undefined) throw new Error('target test followup was not created')
      const collaboration = await h.service.collaborationFor(senderAgent)
      expect(collaboration.sender.id).toBe(sender.bot.id)
      await expect(collaboration.send({
        targetBotId: target.bot.id,
        text: 'Please report your status.',
      })).resolves.toMatchObject({
        status: 'accepted',
        sender: { id: sender.bot.id },
        target: { id: target.bot.id },
      })
      expect(targetFollowup).toHaveBeenCalledTimes(1)
      expect(h.resolveAgent).toHaveBeenCalledWith(target.bot.sessionId)
      expect(h.flush).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })

  it('durably records native collaboration action observations on the Bot Session', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Native owner', cwd: '/tmp' })
    await close(first.ctx)
    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)])
    try {
      const agent = h.agents[0]
      if (agent === undefined) throw new Error('native test Agent was not created')
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native action provider was not mounted')
      const event = {
        phase: 'settled' as const,
        name: 'list_bots',
        callId: 'call-native',
        threadId: 'thread-native',
        turnId: 'turn-native',
        sessionId: agent.id,
        arguments: {},
        result: { success: true, contentItems: [{ type: 'inputText' as const, text: '[]' }] },
      }
      await provider.observe(event)
      expect(agent.session.snapshotEvents()).toMatchObject([{
        type: 'bot/dynamic-tool', data: event,
      }])
      await expect(provider.replay({ sessionId: agent.id })).resolves.toEqual([event])
      expect(h.flush).toHaveBeenCalledWith(agent.session)
    } finally {
      await close(h.ctx)
    }
  })

  it('creates one real Session mapping, lists it, and renames it', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({
        name: 'Research partner', identity: 'sparkle', accent: 'blue', cwd: '/tmp',
      })
      expect(created.bot.state).toBe('active')
      expect(created.bot.identity).toBe('sparkle')
      expect(created.bot.accent).toBe('blue')
      expect(created.bot.sessionId).toMatch(/^bot-session-/)
      expect(h.create).toHaveBeenCalledWith({
        sessionId: created.bot.sessionId, cwd: '/tmp',
      })

      await expect(h.service.list({})).resolves.toMatchObject({
        bots: [{ id: created.bot.id, sessionId: created.bot.sessionId, availability: 'offline' }],
      })
      await expect(h.service.rename({ botId: created.bot.id, name: 'Research desk' })).resolves.toMatchObject({
        bot: { id: created.bot.id, name: 'Research desk', sessionId: created.bot.sessionId },
      })
    } finally {
      await close(h.ctx)
    }
  })

  it('keeps a provisioning row retryable with the same Session id', async () => {
    const create = vi.fn(async (request: { sessionId?: string }) => {
      if (create.mock.calls.length === 1) throw new Error('model unavailable')
      return { sessionId: request.sessionId }
    })
    const h = await harness(new MemoryMediaPool(), create)
    try {
      const id = BotId('bot-retry')
      const failed = h.service.create({ id, name: 'Retry me', cwd: '/tmp' })
      await expect(failed).rejects.toMatchObject({
        code: 'bot/provisioning-failed',
      })
      const firstSessionId = create.mock.calls[0]?.[0]?.sessionId
      expect(firstSessionId).toMatch(/^bot-session-/)
      await expect(h.service.list({})).resolves.toMatchObject({
        bots: [{ id, state: 'provisioning', sessionId: firstSessionId }],
      })
      const retried = await h.service.create({ id, name: 'Retry me', cwd: '/tmp' })
      expect(retried.bot.state).toBe('active')
      expect(create).toHaveBeenNthCalledWith(2, { sessionId: firstSessionId, cwd: '/tmp' })
    } finally {
      await close(h.ctx)
    }
  })

  it('does not create a Session when the durable row cannot be written', async () => {
    const pool = new MemoryMediaPool()
    const h = await harness(pool)
    try {
      pool.failNextWrites = 1
      await expect(h.service.create({ name: 'No orphan', cwd: '/tmp' })).rejects.toThrow('injected write failure')
      expect(h.create).not.toHaveBeenCalled()
      await expect(h.service.list({})).resolves.toEqual({ bots: [] })
    } finally {
      await close(h.ctx)
    }
  })

  it('reloads the same roster from durable storage without creating another Session', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Persistent', identity: 'goal', accent: 'amber', cwd: '/tmp' })
    await close(first.ctx)

    const second = await harness(pool)
    try {
      await expect(second.service.list({})).resolves.toMatchObject({
        bots: [{ id: created.bot.id, sessionId: created.bot.sessionId, state: 'active' }],
      })
      await expect(second.service.create({
        id: created.bot.id, name: 'Persistent', identity: 'goal', accent: 'amber', cwd: '/tmp',
      })).resolves.toMatchObject({
        bot: { id: created.bot.id, sessionId: created.bot.sessionId, state: 'active' },
      })
      expect(second.create).not.toHaveBeenCalled()
      await expect(second.service.create({
        id: created.bot.id, name: 'Different name', identity: 'goal', accent: 'amber', cwd: '/tmp',
      })).rejects.toMatchObject({ code: 'bot/id-conflict' })
    } finally {
      await close(second.ctx)
    }
  })

  it('teaches an existing Bot Session its current name and refreshes it after rename', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Persistent identity', cwd: '/tmp' })
    await close(first.ctx)

    const second = await harness(pool, undefined, undefined, [String(created.bot.sessionId)])
    try {
      const agent = second.agents[0]
      if (agent === undefined) throw new Error('test agent was not created')
      await second.ctx.serial('agent/created', { agent, source: 'resume' })

      const prompt = async () => renderPrompt(await second.ctx.systemPrompt.assemble({ scope: agent }))
      expect(await prompt()).toContain('Persistent identity')
      await second.service.rename({ botId: created.bot.id, name: 'Renamed identity' })
      expect(await prompt()).toContain('Renamed identity')
      expect(await prompt()).not.toContain('Persistent identity')
    } finally {
      await close(second.ctx)
    }
  })

  it('replaces legacy generated avatars once while retaining the Bot and allowing future selection', async () => {
    const pool = new MemoryMediaPool()
    const avatar: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ca'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 64,
      height: 64,
    }
    const legacy = {
      id: 'bot-legacy-avatar',
      sessionId: 'bot-session-legacy-avatar',
      name: 'Legacy avatar',
      identity: 'agent',
      accent: 'violet',
      avatar,
      cwd: '/tmp',
      state: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    pool.versions.set('agent_bots', 1)
    pool.media.set('agent_bots', {
      tables: new Map([['bots', new Map([[legacy.id, legacy]])]]),
      global: null,
    })

    const second = await harness(pool)
    try {
      const migrated = await second.service.list({})
      expect(migrated.bots).toMatchObject([{
        id: legacy.id,
        sessionId: legacy.sessionId,
        name: 'Legacy avatar',
      }])
      expect(migrated.bots[0]).not.toHaveProperty('avatar')

      const replacement: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'cb'.repeat(32)}`),
        mediaType: 'image/png',
        bytes: 3,
        width: 64,
        height: 64,
      }
      await second.service.updateAvatar({ botId: BotId(legacy.id), avatar: replacement })
      await close(second.ctx)

      const third = await harness(pool)
      try {
        await expect(third.service.list({})).resolves.toMatchObject({ bots: [{ id: legacy.id, avatar: replacement }] })
      } finally {
        await close(third.ctx)
      }
    } catch (error) {
      await close(second.ctx)
      throw error
    }
  })

  it('retries an incomplete legacy avatar migration after a durable write failure', async () => {
    const pool = new MemoryMediaPool()
    const avatar: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'cc'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 64,
      height: 64,
    }
    const legacy = {
      id: 'bot-retry-avatar',
      sessionId: 'bot-session-retry-avatar',
      name: 'Retry avatar migration',
      identity: 'agent',
      accent: 'violet',
      avatar,
      cwd: '/tmp',
      state: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    pool.versions.set('agent_bots', 1)
    pool.media.set('agent_bots', {
      tables: new Map([['bots', new Map([[legacy.id, legacy]])]]),
      global: null,
    })
    pool.failNextWrites = 1

    await expect(harness(pool)).rejects.toThrow('injected write failure')
    expect(pool.media.get('agent_bots')?.tables.get('bots')?.get(legacy.id)).toHaveProperty('avatar')

    const retried = await harness(pool)
    try {
      const listed = await retried.service.list({})
      expect(listed.bots[0]).not.toHaveProperty('avatar')
      expect(pool.media.get('agent_bots')?.global).toEqual({ animatedAvatarVersion: 1 })
    } finally {
      await close(retried.ctx)
    }
  })

  it('rejects an active id retry when omitted optional metadata differs', async () => {
    const h = await harness()
    try {
      const id = BotId('bot-metadata-conflict')
      const created = await h.service.create({
        id,
        name: 'Metadata owner',
        description: 'First description',
        identity: 'goal',
        accent: 'amber',
        cwd: '/tmp/first-bot-directory',
        agentPreset: 'first-preset',
      })

      await expect(h.service.create({
        id,
        name: created.bot.name,
        identity: created.bot.identity,
        accent: created.bot.accent,
      })).rejects.toMatchObject({ code: 'bot/id-conflict' })
      expect(h.create).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })

  it('persists and clears a generated avatar without changing the Bot Session mapping', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({ name: 'Avatar owner', cwd: '/tmp' })
      const avatar: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
        mediaType: 'image/png',
        bytes: 3,
        width: 64,
        height: 64,
        name: 'avatar.png',
      }
      await expect(h.service.updateAvatar({ botId: created.bot.id, avatar })).resolves.toMatchObject({
        bot: { id: created.bot.id, sessionId: created.bot.sessionId, avatar },
      })
      expect(h.readImage).toHaveBeenCalledWith(avatar)
      await expect(h.service.list({})).resolves.toMatchObject({ bots: [{ id: created.bot.id, avatar }] })
      await expect(h.service.readAvatar({ botId: created.bot.id })).resolves.toEqual({
        avatar,
        data: Buffer.from([1, 2, 3]).toString('base64'),
      })
      await expect(h.service.updateAvatar({ botId: created.bot.id, avatar: null })).resolves.toMatchObject({
        bot: { id: created.bot.id, sessionId: created.bot.sessionId },
      })
      const listed = await h.service.list({})
      expect(listed.bots).toHaveLength(1)
      expect(listed.bots[0]?.id).toBe(created.bot.id)
      expect(listed.bots[0]).not.toHaveProperty('avatar')
      await expect(h.service.readAvatar({ botId: created.bot.id })).rejects.toMatchObject({ code: 'bot/avatar-missing' })
    } finally {
      await close(h.ctx)
    }
  })

  it('rejects malformed or unreadable avatar references without changing the Bot row', async () => {
    const readImage = vi.fn(async (): Promise<StoredImageAttachment> => {
      throw new Error('attachment missing')
    })
    const h = await harness(new MemoryMediaPool(), undefined, readImage)
    try {
      const created = await h.service.create({ name: 'Avatar guard', cwd: '/tmp' })
      const invalid = { attachmentId: 'not-a-digest', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
      await expect(h.service.updateAvatar({ botId: created.bot.id, avatar: invalid as never }))
        .rejects.toMatchObject({ code: 'bot/avatar-invalid', details: { reason: 'invalid-reference' } })
      await expect(h.service.updateAvatar({
        botId: created.bot.id,
        avatar: {
          attachmentId: AttachmentId(`sha256:${'ef'.repeat(32)}`),
          mediaType: 'image/png', bytes: 3, width: 1, height: 1,
        },
      })).rejects.toMatchObject({ code: 'bot/avatar-invalid', details: { reason: 'unreadable' } })
      const listed = await h.service.list({})
      expect(listed.bots).toHaveLength(1)
      expect(listed.bots[0]?.id).toBe(created.bot.id)
      expect(listed.bots[0]).not.toHaveProperty('avatar')
    } finally {
      await close(h.ctx)
    }
  })

  it('updates identity and accent without replacing its Session or generated avatar, emits a change, and reloads', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const avatar: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 64,
      height: 64,
    }
    let firstClosed = false
    try {
      const created = await first.service.create({ name: 'Appearance owner', cwd: '/tmp' })
      await first.service.updateAvatar({ botId: created.bot.id, avatar })
      const changes: number[] = []
      first.ctx.on('bots/changed', () => { changes.push(changes.length + 1) })

      await expect(first.service.updateAppearance({
        botId: created.bot.id,
        identity: 'browse',
        accent: 'teal',
      })).resolves.toMatchObject({
        bot: {
          id: created.bot.id,
          sessionId: created.bot.sessionId,
          identity: 'browse',
          accent: 'teal',
          avatar,
        },
      })
      expect(changes).toEqual([1])
      expect(first.create).toHaveBeenCalledTimes(1)
      await close(first.ctx)
      firstClosed = true

      const second = await harness(pool)
      try {
        await expect(second.service.list({})).resolves.toMatchObject({
          bots: [{
            id: created.bot.id,
            sessionId: created.bot.sessionId,
            identity: 'browse',
            accent: 'teal',
            avatar,
          }],
        })
        expect(second.create).not.toHaveBeenCalled()
      } finally {
        await close(second.ctx)
      }
    } finally {
      if (!firstClosed) await close(first.ctx)
    }
  })

  it('clears a generated avatar only when updateAppearance explicitly requests it', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({ name: 'Appearance clear', cwd: '/tmp' })
      const avatar: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'bc'.repeat(32)}`),
        mediaType: 'image/png',
        bytes: 3,
        width: 64,
        height: 64,
      }
      await h.service.updateAvatar({ botId: created.bot.id, avatar })

      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        identity: 'skill',
        clearAvatar: true,
      })).resolves.toMatchObject({
        bot: {
          id: created.bot.id,
          sessionId: created.bot.sessionId,
          identity: 'skill',
          accent: 'violet',
        },
      })
      const listed = await h.service.list({})
      expect(listed.bots[0]).not.toHaveProperty('avatar')
      await expect(h.service.readAvatar({ botId: created.bot.id })).rejects.toMatchObject({ code: 'bot/avatar-missing' })
      expect(h.create).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })

  it('rejects invalid appearance fields without changing the Bot row or emitting a change', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({ name: 'Appearance guard', cwd: '/tmp' })
      const changes: number[] = []
      h.ctx.on('bots/changed', () => { changes.push(changes.length + 1) })
      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        identity: 'unknown' as never,
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        accent: 'unknown' as never,
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        clearAvatar: 'yes' as never,
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      await expect(h.service.updateAppearance({ botId: created.bot.id })).rejects.toMatchObject({ code: 'gateway/bad-request' })

      await expect(h.service.list({})).resolves.toMatchObject({
        bots: [{
          id: created.bot.id,
          sessionId: created.bot.sessionId,
          identity: 'agent',
          accent: 'violet',
        }],
      })
      expect(changes).toEqual([])
      expect(h.create).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })
})
