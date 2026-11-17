import { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { ToolCallId } from '@yharness/llm'
import { createScope } from '@yharness/scope'
import { Session, SessionId } from '@yharness/session'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import type { BotEventRoutineToolHost } from '../src/routine-tools.ts'
import { describe, expect, it, vi } from 'vitest'
import { registerScheduleTools } from '@yharness/tool-schedule'
import { installBotRoutineTools } from '../src/routine-tools.ts'

async function fixture(eventHost?: BotEventRoutineToolHost) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const id = SessionId('bot-session-alpha')
  const agent = { id, options: {}, session: Session.create(id) } as Agent
  const scope = createScope(ctx, agent)
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  const schedule = {
    create: vi.fn(async () => ({ id: 'routine-1', kind: 'after', title: 'Check', prompt: 'Check', afterSeconds: 60, scheduledAt: '2099-01-01T00:00:00.000Z' })),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => ({ id: 'routine-1', deleted: true as const })),
    update: vi.fn(async () => ({ id: 'routine-1', updated: false as const, code: 'schedule_not_found' as const })),
    catalog: vi.fn(async () => []),
  }
  ctx.provide('schedule', schedule as never)
  const scheduleTools = agent.ctx.inject(['schedule', 'tools'], (scheduleScope: Context) => { registerScheduleTools(scheduleScope) })
  await scheduleTools
  const fiber = installBotRoutineTools(agent.ctx, eventHost)
  await fiber
  return { ctx, agent, schedule, dispose: () => scope.dispose() }
}

async function execute(
  ctx: Context,
  agent: Agent,
  name: string,
  arguments_: unknown,
  signal: AbortSignal = new AbortController().signal,
) {
  return ctx.tools.execute({
    callId: ToolCallId(`routine-call-${name}`), name, arguments: arguments_,
    signal, agent,
  })
}

describe('Bot routine tools', () => {
  it('does not mount routine policy outside a Bot scope', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = installBotRoutineTools(ctx)
    await fiber
    try {
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('binds routines to the Bot Session and asks before mutating schedules', async () => {
    const h = await fixture()
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
        'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
        'schedule_pause', 'schedule_resume', 'schedule_history',
      ]))

      const listed = await execute(h.ctx, h.agent, 'schedule_list', {})
      expect(listed).toMatchObject({ isError: false, value: [] })
      expect(h.schedule.list).toHaveBeenCalledWith({ sessionId: h.agent.id })

      const denied = await execute(h.ctx, h.agent, 'schedule_create', {
        title: 'Check', prompt: 'Check the report', after_seconds: 60,
      })
      expect(denied.isError).toBe(true)
      expect(h.schedule.create).not.toHaveBeenCalled()
    } finally {
      await h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('dispatches every event-routine action, denies mutations, and removes them with the scope', async () => {
    const run = vi.fn<BotEventRoutineToolHost['run']>(async action => ({ action }))
    const eventHost: BotEventRoutineToolHost = { run }
    const h = await fixture(eventHost)
    const createArgs = {
      title: 'Synthetic event routine',
      prompt: 'Record a synthetic event.',
      event: { type: 'message' as const, source: 'user' as const },
    }
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
        'schedule_event_create', 'schedule_event_list', 'schedule_event_update',
        'schedule_event_delete', 'schedule_event_pause', 'schedule_event_resume', 'schedule_event_history',
      ]))

      const denied = await execute(h.ctx, h.agent, 'schedule_event_create', createArgs)
      expect(denied.isError).toBe(true)
      expect(run).not.toHaveBeenCalled()

      h.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
      const actions = [
        ['create', createArgs],
        ['list', {}],
        ['update', { id: 'routine-1', title: 'Updated' }],
        ['delete', { id: 'routine-1' }],
        ['pause', { id: 'routine-1' }],
        ['resume', { id: 'routine-1' }],
        ['history', { id: 'routine-1', limit: 5 }],
      ] as const
      for (const [action, arguments_] of actions) {
        const result = await execute(h.ctx, h.agent, `schedule_event_${action}`, arguments_)
        expect(result).toMatchObject({ isError: false, value: { action } })
      }
      expect(run).toHaveBeenCalledTimes(actions.length)
      const firstCall = run.mock.calls[0]
      expect(firstCall?.[0]).toBe('create')
      expect(firstCall?.[1]).toEqual(createArgs)
      expect(firstCall?.[2].agent).toBe(h.agent)
      expect(firstCall?.[2].signal).toBeInstanceOf(AbortSignal)

      await h.dispose()
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).not.toEqual(expect.arrayContaining([
        'schedule_event_create', 'schedule_event_history',
      ]))
    } finally {
      await h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('does not dispatch an event routine after caller cancellation', async () => {
    const run = vi.fn<BotEventRoutineToolHost['run']>(async action => ({ action }))
    const eventHost: BotEventRoutineToolHost = { run }
    const h = await fixture(eventHost)
    const controller = new AbortController()
    controller.abort('synthetic cancellation')
    try {
      const result = await execute(h.ctx, h.agent, 'schedule_event_list', {}, controller.signal)
      expect(result.isError).toBe(true)
      expect(run).not.toHaveBeenCalled()
    } finally {
      await h.dispose()
      await h.ctx.fiber.dispose()
    }
  })
})
