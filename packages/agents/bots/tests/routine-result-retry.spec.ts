import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@yharness/session'
import { freezeMessage, MessageId, type UserMessage } from '@yharness/llm'
import { BotId } from '../src/types.ts'
import { closeRoutineHarness, completedTurnEvent, invokeRoutine, rawBotRow, routineHarness } from './routine-test-harness.ts'

describe('event routine result recovery', () => {
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

  it('can recover a second transient inspection failure for the same Bot', async () => {
    vi.useFakeTimers()
    const harness = await routineHarness()
    try {
      const { bot } = await harness.service.create({ id: BotId('bot-routine-result-recovered'), name: 'Recovered routine', cwd: '/tmp' })
      const routine = await invokeRoutine(harness.service, 'create', {
        title: 'Review report', prompt: 'Read the report.', event: { type: 'message', source: 'user' },
      }, bot.sessionId, 'create-result-recovery-rule')
      if (typeof routine !== 'object' || routine === null || !('id' in routine) || typeof routine.id !== 'string') {
        throw new Error('Routine creation did not return an id')
      }
      const { session } = harness.agent
      session.append('turn/start', { turn: 1 })
      session.append('user/message', freezeMessage<UserMessage>({
        id: MessageId('recovered-result-message'),
        role: 'user',
        source: { kind: 'bot-event-routine', form: 'notice', summary: 'Review report', routineId: routine.id, triggerEventSeq: 1 },
        content: [{ type: 'text', text: 'Read the report.' }],
      }), { surfaceOp: 'append' })
      completedTurnEvent(session)
      const inspection = await harness.ctx.sessionController.inspect(bot.sessionId)
      const inspect = vi.spyOn(harness.ctx.sessionController, 'inspect')
        .mockRejectedValueOnce(new Error('fixture Session read interrupted'))
        .mockResolvedValue({ ...inspection, events: session.snapshotEvents() })

      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(harness.service), 'recoverEventRoutineResults')
      if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('Result recovery is unavailable')
      const recover = descriptor.value as (this: typeof harness.service, sessionId: SessionId) => Promise<void>
      await recover.call(harness.service, bot.sessionId)
      await vi.runAllTimersAsync()
      expect(rawBotRow(harness.pool, bot.id)?.eventRoutines?.[0]?.results).toMatchObject([
        { messageId: 'recovered-result-message', status: 'completed' },
      ])

      inspect.mockRejectedValueOnce(new Error('fixture second Session read interrupted'))
      await recover.call(harness.service, bot.sessionId)
      await vi.runAllTimersAsync()
      expect(inspect).toHaveBeenCalledTimes(4)
      expect(rawBotRow(harness.pool, bot.id)?.eventRoutines?.[0]?.results).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await closeRoutineHarness(harness)
    }
  })
})
