import { describe, expect, it, vi } from 'vitest'
import { SessionSeq, type SessionEvent } from '@yharness/session'
import {
  BOT_MEMORY_ENTRY_LIMIT,
  BOT_MEMORY_SEARCH_LIMIT,
  BOT_MEMORY_TEXT_LIMIT,
  BotMemoryId,
  normalizeBotMemoryText,
  parseBotMemoryId,
  projectBotMemories,
  projectBotMemoryState,
  searchBotMemories,
} from '../src/memory.ts'
import { BotId } from '../src/types.ts'

const BOT_ID = BotId('bot-memory-fixture')

function memoryEvent(
  data: unknown,
  seq: number | ReturnType<typeof SessionSeq> = SessionSeq(0),
  time = 1,
  type: string = 'bot/memory',
): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

function rememberData(memoryId = 'memory-note', text = 'Keep this note.') {
  return { botId: String(BOT_ID), memoryId, operation: 'remember', text }
}

function forgetData(memoryId = 'memory-note') {
  return { botId: String(BOT_ID), memoryId, operation: 'forget' }
}

describe('Bot memory projection', () => {
  it('validates memory ids and normalizes text at the wire boundary', () => {
    expect(parseBotMemoryId('memory-note-1')).toBe('memory-note-1')
    expect(() => parseBotMemoryId(42 as never)).toThrow(/Memory ids must begin/)
    expect(() => parseBotMemoryId('note-1')).toThrow(/Memory ids must begin/)
    expect(() => parseBotMemoryId(`memory-${'x'.repeat(256)}`)).toThrow(/Memory ids must begin/)

    expect(normalizeBotMemoryText('  Keep this note.  ')).toBe('Keep this note.')
    expect(() => normalizeBotMemoryText(null as never)).toThrow('Memory text must be a string.')
    expect(() => normalizeBotMemoryText('')).toThrow(/Memory text must contain/)
    expect(() => normalizeBotMemoryText('x'.repeat(BOT_MEMORY_TEXT_LIMIT + 1))).toThrow(/Memory text must contain/)
  })

  it('reconstructs active records and forget tombstones across persisted events', () => {
    const events = [
      null as never,
      memoryEvent({}, 0, 1, 'user/message'),
      memoryEvent(rememberData('memory-first', '  First note.  '), 1, 2),
      memoryEvent(rememberData('memory-first', 'First note.'), 2, 3),
      memoryEvent(forgetData('memory-first'), 3, 4),
      memoryEvent(rememberData('memory-first', 'Replacement note.'), 4, 5),
      memoryEvent(forgetData('memory-second'), 5, 6),
    ]

    const state = projectBotMemoryState(events, BOT_ID)
    expect([...state.memories.values()]).toEqual([{
      id: BotMemoryId('memory-first'), text: 'Replacement note.', createdAt: 5,
    }])
    expect(state.forgotten).toEqual(new Set(['memory-second']))
    expect(projectBotMemories(events, BOT_ID)).toEqual(state.memories)
  })

  it('rejects malformed persisted memory events instead of importing them', () => {
    const malformed = (data: unknown, seq = SessionSeq(0), time = 1) => memoryEvent(data, seq, time)
    const expectInvalid = (event: SessionEvent, message: RegExp): void => {
      expect(() => projectBotMemories([event], BOT_ID)).toThrow(message)
    }

    expectInvalid(malformed(forgetData(), 1.5 as never), /event sequence must be a non-negative safe integer/)
    expectInvalid(malformed(forgetData(), -1 as never), /event sequence must be a non-negative safe integer/)
    expectInvalid(malformed(forgetData(), SessionSeq(0), 1.5), /event time must be a non-negative safe integer/)
    expectInvalid(malformed(forgetData(), SessionSeq(0), -1), /event time must be a non-negative safe integer/)
    expectInvalid(malformed(null), /data must be an object/)
    expectInvalid(malformed([]), /data must be an object/)
    expectInvalid(malformed({ ...forgetData(), extra: true }), /data contains an unknown field/)
    expectInvalid(malformed({ ...forgetData(), botId: 42 }), /botId is invalid/)
    expectInvalid(malformed({ ...forgetData(), botId: 'not-a-bot' }), /botId is invalid/)
    expectInvalid(malformed({ ...forgetData(), botId: 'bot-other' }), /belongs to Bot/)
    expectInvalid(malformed({ ...forgetData(), memoryId: 42 }), /memoryId is invalid/)
    expectInvalid(malformed({ ...forgetData(), memoryId: 'note' }), /memoryId is invalid/)
    expectInvalid(malformed({ ...forgetData(), memoryId: `memory-${'x'.repeat(256)}` }), /memoryId is invalid/)
    expectInvalid(malformed({ ...rememberData(), text: 42 }), /remember events require text/)
    expectInvalid(malformed(rememberData('memory-empty', '')), /Memory text must contain/)
    expectInvalid(malformed({ ...forgetData(), operation: 'update' }), /operation must be remember or forget/)
    expectInvalid(malformed({ ...forgetData(), text: 'unexpected' }), /forget events must not contain text/)
  })

  it('wraps an unexpected text-normalization failure during import', () => {
    const trim = vi.spyOn(String.prototype, 'trim').mockImplementation(() => {
      throw new Error('fixture normalization failure')
    })
    try {
      expect(() => projectBotMemories([memoryEvent(rememberData())], BOT_ID))
        .toThrow(/remember text is invalid/)
    } finally {
      trim.mockRestore()
    }
    expect(normalizeBotMemoryText('  Restored.  ')).toBe('Restored.')
  })

  it('rejects conflicting remembered text after a durable replay', () => {
    const events = [
      memoryEvent(rememberData('memory-conflict', 'First note.'), 0, 1),
      memoryEvent(rememberData('memory-conflict', 'Different note.'), 1, 2),
    ]
    expect(() => projectBotMemories(events, BOT_ID)).toThrow(/conflicting text/)
  })

  it('retains a larger durable projection while paging and searching bounded results', () => {
    expect(BOT_MEMORY_ENTRY_LIMIT).toBeGreaterThanOrEqual(180)
    const memories = Array.from({ length: 180 }, (_, index) => ({
      id: BotMemoryId(`memory-entry-${String(index + 1)}`),
      text: `Research entry ${String(index + 1)}`,
      createdAt: index + 1,
    }))

    const first = searchBotMemories(memories, {})
    expect(first.memories).toHaveLength(BOT_MEMORY_SEARCH_LIMIT)
    expect(first.memories[0]?.id).toBe(BotMemoryId('memory-entry-180'))
    expect(first.memories.at(-1)?.id).toBe(BotMemoryId('memory-entry-161'))
    expect(first.nextBefore).toBe(BotMemoryId('memory-entry-161'))
    if (first.nextBefore === undefined) throw new Error('first memory page did not return a cursor')

    const second = searchBotMemories(memories, { before: first.nextBefore, limit: 7 })
    expect(second.memories.map(memory => String(memory.id))).toEqual([
      'memory-entry-160', 'memory-entry-159', 'memory-entry-158', 'memory-entry-157',
      'memory-entry-156', 'memory-entry-155', 'memory-entry-154',
    ])
    expect(second.nextBefore).toBe(BotMemoryId('memory-entry-154'))

    const match = searchBotMemories(memories, { query: '  ENTRY 42 ' })
    expect(match.memories.map(memory => String(memory.id))).toEqual(['memory-entry-42'])
    expect(() => searchBotMemories(memories, { limit: BOT_MEMORY_SEARCH_LIMIT + 1 })).toThrow(/between 1 and/)
    expect(() => searchBotMemories(memories, { before: BotMemoryId('memory-missing') })).toThrow(/cursor was not found/)
  })
})
