import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@yharness/llm'
import { Session, SessionId } from '@yharness/session'
import { BotId } from '../src/types.ts'
import { closeRoutineHarness, completedTurnEvent, invokeRoutine, rawBotRow, routineHarness } from './routine-test-harness.ts'

describe('event routine result recovery', () => {
  it('recovers one persisted result after the session read succeeds on retry', async () => {
    const harness = await routineHarness()
    try {
      const { bot } = await harness.service.create({ name: 'Result recovery bot', cwd: '/tmp' })
      await invokeRoutine(harness.service, 'create', {
        title: 'Record results', prompt: 'Summarize the event.', event: { type: 'message', source: 'user' },
      }, bot.sessionId, 'create-result-recovery-routine')
      const [routine] = (await harness.service.listRoutines({ botId: bot.id })).routines
      if (routine?.kind !== 'event') throw new Error('Message routine was not created')
      const session = Session.create(bot.sessionId)
      const message = createUserMessage({
        content: [{ type: 'text', text: 'Summarize the event.' }],
        source: { kind: 'bot-event-routine', form: 'notice', summary: 'Routine triggered', routineId: routine.id, triggerEventSeq: 1 },
      })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn: 1, step: 1, stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'Recovered once.' }],
          source: { provider: 'test', model: 'test-model' },
        }),
      }, { surfaceOp: 'append' })
      completedTurnEvent(session)

      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(harness.service), 'recoverEventRoutineResults')
      if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('Result recovery is unavailable')
      const recover = descriptor.value as (this: typeof harness.service, id: SessionId) => Promise<void>
      const readSession = vi.spyOn(harness.ctx.sessionController, 'inspect')
        .mockRejectedValueOnce(new Error('Startup session read failed'))
        .mockRejectedValueOnce(new Error('Immediate session retry failed'))
        .mockResolvedValue({
          meta: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents(),
        })
      const request = { botId: bot.id, routineId: routine.id, limit: 10 }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await recover.call(harness.service, bot.sessionId)
      expect(await harness.service.routineHistory(request)).toMatchObject({ results: [] })
      await vi.advanceTimersByTimeAsync(100)
      expect(readSession).toHaveBeenCalledTimes(3)
      const expected = { results: [{ messageId: message.id, status: 'completed', output: 'Recovered once.' }] }
      expect(await harness.service.routineHistory(request)).toMatchObject(expected)
      await recover.call(harness.service, bot.sessionId)
      expect(await harness.service.routineHistory(request)).toMatchObject(expected)
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
