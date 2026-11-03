import { describe, expect, it } from 'vitest'
import { SessionId } from '@yharness/session'
import { createUserMessage } from '@yharness/llm'
import { BotId } from '../src/types.ts'
import { closeRoutineHarness, invokeRoutine, invokeRoutineTrigger, rawBotRow, routineHarness } from './routine-test-harness.ts'

describe('event routine cross-process fencing', () => {
  it('preserves a routine when a stale Host commits a profile edit', async () => {
    const first = await routineHarness()
    const created = await first.service.create({ id: BotId('bot-routine-fence'), name: 'Fence bot', cwd: '/tmp' })
    const second = await routineHarness(first.pool, first.records)
    try {
      const sessionId = SessionId(String(created.bot.sessionId))
      await invokeRoutine(first.service, 'create', {
        title: 'On message', prompt: 'Remember this', event: { type: 'message', source: 'user' },
      }, sessionId, 'create-routine')

      await second.service.rename({ botId: created.bot.id, name: 'Renamed by stale Host' })

      const row = rawBotRow(first.pool, created.bot.id)
      expect(row?.name).toBe('Renamed by stale Host')
      expect(row?.eventRoutines).toHaveLength(1)
    } finally {
      await closeRoutineHarness(second)
      await closeRoutineHarness(first)
    }
  })

  it('reloads a cross-process routine before admitting a matching message', async () => {
    const first = await routineHarness()
    const created = await first.service.create({ id: BotId('bot-routine-admission'), name: 'Admission bot', cwd: '/tmp' })
    const second = await routineHarness(first.pool, first.records)
    try {
      const sessionId = SessionId(String(created.bot.sessionId))
      const routine = await invokeRoutine(first.service, 'create', {
        title: 'On message', prompt: 'Remember this', event: { type: 'message', source: 'user' },
      }, sessionId, 'create-routine')
      if (typeof routine !== 'object' || routine === null || !('id' in routine) || typeof routine.id !== 'string') {
        throw new Error('routine creation did not return an id')
      }

      await invokeRoutineTrigger(second.service, sessionId, createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }))

      const row = rawBotRow(first.pool, created.bot.id)
      expect(row?.eventRoutines?.[0]?.deliveries).toHaveLength(1)
      expect(row?.eventRoutines?.[0]?.deliveries[0]?.status).toBe('pending')
    } finally {
      await closeRoutineHarness(second)
      await closeRoutineHarness(first)
    }
  })
})
