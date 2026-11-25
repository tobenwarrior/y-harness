import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import { BotId } from '../src/types.ts'
import { closeRoutineHarness, completedTurnEvent, invokeRoutine, rawBotRow, routineHarness } from './routine-test-harness.ts'

describe('event routine result recovery', () => {
  it('recovers a later routine result after an earlier startup retry has settled', async () => {
    vi.useFakeTimers()
    const harness = await routineHarness()
    try {
      const botId = BotId('bot-routine-startup-retry')
      const created = await harness.service.create({ id: botId, name: 'Recovery bot', cwd: '/tmp' })
      const sessionId = SessionId(String(created.bot.sessionId))
      const routine = await invokeRoutine(harness.service, 'create', {
        title: 'On message', prompt: 'Record this', event: { type: 'message', source: 'user' },
      }, sessionId, 'create-startup-recovery')
      if (typeof routine !== 'object' || routine === null || !('id' in routine) || typeof routine.id !== 'string') {
        throw new Error('routine creation did not return an id')
      }
      const session = harness.agent.session
      const inspectSession = harness.ctx.sessionController.inspect.bind(harness.ctx.sessionController)
      const inspect = vi.spyOn(harness.ctx.sessionController, 'inspect').mockImplementation(async id => ({
        ...await inspectSession(id),
        events: session.snapshotEvents(),
      }))
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(harness.service), 'recoverEventRoutineResults')
      if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('result recovery adapter is unavailable')
      const recover = descriptor.value as (this: typeof harness.service, sessionId: SessionId) => Promise<void>

      for (const [turn, output] of [[1, 'First recovered result'], [2, 'Second recovered result']] as const) {
        session.append('turn/start', { turn })
        const message = createUserMessage({
          content: [{ type: 'text', text: 'Run the routine' }],
          source: {
            kind: 'bot-event-routine', form: 'notice', summary: 'Routine triggered', routineId: routine.id,
            triggerEventSeq: turn, chainId: 'startup-result-test', depth: 0,
          },
        })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn, step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: output }],
            source: { provider: 'test', model: 'test-model' },
          }),
          stream: [],
        }, { surfaceOp: 'append' })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
        inspect.mockRejectedValueOnce(new Error('Session inspection temporarily unavailable'))

        await recover.call(harness.service, sessionId)
        await vi.runAllTimersAsync()

        expect(rawBotRow(harness.pool, botId)?.eventRoutines?.[0]?.results).toContainEqual(
          expect.objectContaining({ messageId: message.id, status: 'completed', output }),
        )
      }
      expect(inspect).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
      await closeRoutineHarness(harness)
    }
  })

  it('retries a transient result-row write while the Host remains live', async () => {
    vi.useFakeTimers()
    const harness = await routineHarness()
    try {
      const created = await harness.service.create({ id: BotId('bot-routine-result'), name: 'Result bot', cwd: '/tmp' })
      const sessionId = SessionId(String(created.bot.sessionId))
      const routine = await invokeRoutine(harness.service, 'create', {
        title: 'On message', prompt: 'Record this', event: { type: 'message', source: 'user' },
      }, sessionId, 'create-routine')
      if (typeof routine !== 'object' || routine === null || !('id' in routine) || typeof routine.id !== 'string') {
        throw new Error('routine creation did not return an id')
      }
      const event = completedTurnEvent(harness.agent.session)

      harness.pool.failNextWrites = 1
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(harness.service), 'recordEventRoutineResults')
      if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('result adapter is unavailable')
      type RecordResults = (
        sessionId: SessionId,
        turn: { readonly turn: number; readonly runs: Map<string, string>; readonly output: string[] },
        turnEvent: typeof event,
        persistedTurn: { readonly turn: number; readonly runs: Map<string, string>; readonly output: string[] },
      ) => Promise<void>
      const recordResults = descriptor.value as (
        this: typeof harness.service,
        ...args: Parameters<RecordResults>
      ) => ReturnType<RecordResults>
      await recordResults.call(harness.service, sessionId, {
        turn: 1, runs: new Map([['routine-message', routine.id]]), output: ['completed output'],
      }, event, {
        turn: 1, runs: new Map([['routine-message', routine.id]]), output: ['completed output'],
      })
      await vi.runAllTimersAsync()

      const row = rawBotRow(harness.pool, created.bot.id)
      expect(row?.eventRoutines?.[0]?.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageId: 'routine-message', status: 'completed', output: 'completed output' }),
      ]))
    } finally {
      vi.useRealTimers()
      await closeRoutineHarness(harness)
    }
  })

  it('keeps retrying result-row writes after the initial backoff window', async () => {
    vi.useFakeTimers()
    const harness = await routineHarness()
    try {
      const created = await harness.service.create({ id: BotId('bot-routine-result-long-retry'), name: 'Long retry bot', cwd: '/tmp' })
      const sessionId = SessionId(String(created.bot.sessionId))
      const routine = await invokeRoutine(harness.service, 'create', {
        title: 'On message', prompt: 'Record this', event: { type: 'message', source: 'user' },
      }, sessionId, 'create-long-retry-routine')
      if (typeof routine !== 'object' || routine === null || !('id' in routine) || typeof routine.id !== 'string') {
        throw new Error('routine creation did not return an id')
      }
      const event = completedTurnEvent(harness.agent.session)

      harness.pool.failNextWrites = 6
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(harness.service), 'recordEventRoutineResults')
      if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('result adapter is unavailable')
      type RecordResults = (
        sessionId: SessionId,
        turn: { readonly turn: number; readonly runs: Map<string, string>; readonly output: string[] },
        turnEvent: typeof event,
        persistedTurn: { readonly turn: number; readonly runs: Map<string, string>; readonly output: string[] },
      ) => Promise<void>
      const recordResults = descriptor.value as (
        this: typeof harness.service,
        ...args: Parameters<RecordResults>
      ) => ReturnType<RecordResults>
      await recordResults.call(harness.service, sessionId, {
        turn: 1, runs: new Map([['routine-message-long-retry', routine.id]]), output: ['completed output'],
      }, event, {
        turn: 1, runs: new Map([['routine-message-long-retry', routine.id]]), output: ['completed output'],
      })
      await vi.runAllTimersAsync()

      const row = rawBotRow(harness.pool, created.bot.id)
      expect(row?.eventRoutines?.[0]?.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageId: 'routine-message-long-retry', status: 'completed', output: 'completed output' }),
      ]))
    } finally {
      vi.useRealTimers()
      await closeRoutineHarness(harness)
    }
  })
})
