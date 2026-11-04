import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@yharness/session'
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
})
