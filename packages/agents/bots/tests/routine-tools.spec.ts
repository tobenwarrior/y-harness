import { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { ToolCallId } from '@yharness/llm'
import { createScope } from '@yharness/scope'
import { Session, SessionId } from '@yharness/session'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { describe, expect, it, vi } from 'vitest'
import { registerScheduleTools } from '@yharness/tool-schedule'
import { installBotRoutineTools } from '../src/routine-tools.ts'

async function fixture() {
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
  const scheduleTools = agent.ctx.inject(['schedule', 'tools'], (scheduleScope: Context) => registerScheduleTools(scheduleScope))
  await scheduleTools
  const fiber = installBotRoutineTools(agent.ctx)
  await fiber
  return { ctx, agent, schedule, dispose: () => scope.dispose() }
}

async function execute(ctx: Context, agent: Agent, name: string, arguments_: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`routine-call-${name}`), name, arguments: arguments_,
    signal: new AbortController().signal, agent,
  })
}

describe('Bot routine tools', () => {
  it('binds routines to the Bot Session and asks before mutating schedules', async () => {
    const h = await fixture()
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
        'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
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
})
