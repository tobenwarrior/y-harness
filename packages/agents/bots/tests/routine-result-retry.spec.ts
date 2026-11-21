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

  it('clears recovery retry bookkeeping after a successful retry', async () => {
    vi.useFakeTimers()
    const harness = await routineHarness()
    try {
      const created = await harness.service.create({
        id: BotId('bot-routine-recovery-cleanup'),
        name: 'Recovery cleanup bot',
        cwd: '/tmp',
      })
      const sessionId = SessionId(String(created.bot.sessionId))
      await invokeRoutine(harness.service, 'create', {
        title: 'On message', prompt: 'Recover this', event: { type: 'message', source: 'user' },
      }, sessionId, 'create-recovery-cleanup-routine')

      const recoverDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(harness.service),
        'recoverEventRoutineResults',
      )
      const scheduleDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(harness.service),
        'scheduleEventRoutineResultRecoveryRetry',
      )
      if (recoverDescriptor === undefined || typeof recoverDescriptor.value !== 'function'
        || scheduleDescriptor === undefined || typeof scheduleDescriptor.value !== 'function') {
        throw new Error('result recovery adapters are unavailable')
      }
      type RecoverResults = (retrySessionId?: SessionId, retryAttempt?: number) => Promise<void>
      type ScheduleRecovery = (retrySessionId: SessionId, retryAttempt: number, fenceRetry?: boolean) => void
      const recoverResults = recoverDescriptor.value as (
        this: typeof harness.service,
        ...args: Parameters<RecoverResults>
      ) => ReturnType<RecoverResults>
      const recover = vi.fn<RecoverResults>((retrySessionId, retryAttempt) =>
        recoverResults.call(harness.service, retrySessionId, retryAttempt))
      Object.defineProperty(harness.service, 'recoverEventRoutineResults', {
        configurable: true,
        value: recover,
      })
      const scheduleRecovery = scheduleDescriptor.value as (
        this: typeof harness.service,
        ...args: Parameters<ScheduleRecovery>
      ) => ReturnType<ScheduleRecovery>

      scheduleRecovery.call(harness.service, sessionId, 1, false)
      await vi.runAllTimersAsync()
      scheduleRecovery.call(harness.service, sessionId, 1, false)
      await vi.runAllTimersAsync()

      expect(recover).toHaveBeenCalledTimes(2)
      expect(recover).toHaveBeenNthCalledWith(1, sessionId, 1)
      expect(recover).toHaveBeenNthCalledWith(2, sessionId, 1)
    } finally {
      vi.useRealTimers()
      await closeRoutineHarness(harness)
    }
  })
})
