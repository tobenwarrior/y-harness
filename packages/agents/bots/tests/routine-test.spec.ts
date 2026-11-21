/** Reconstruct routine-test state without attributing a different turn's outcome. */

import { brandString } from '@yharness/brand'
import { freezeMessage } from '@yharness/llm'
import { MessageId } from '@yharness/llm/brand'
import { Session, SessionId, type SessionEventMap } from '@yharness/session'
import { describe, expect, it } from 'vitest'
import { routineTestMessageId, routineTestRunFromEvents } from '../src/routine-test.ts'
import type { BotRoutineTestId } from '../src/types.ts'

const routine = 'routine-weekly'
const sessionId = SessionId('test-owner')
const request = brandString<BotRoutineTestId>('2d19b800-dc78-4ec2-9bc0-b780cbab11cc')
const id = routineTestMessageId(sessionId, routine, request)
const message = freezeMessage({
  id, role: 'user', source: { kind: 'schedule', invocation: 'test' },
  content: [{ type: 'text', text: 'Review the example report.' }],
})

function reserve(): Session {
  const session = Session.create(sessionId)
  session.append('bot/routine-test', { routineId: routine, messageId: id })
  return session
}

function status(session: Session) {
  return routineTestRunFromEvents(session.snapshotEvents(), routine, id)?.status
}

describe('Bot routine test journal', () => {
  it('isolates attempt identities by Session and routine', () => {
    expect(routineTestMessageId(sessionId, routine, request)).toBe(id)
    expect(routineTestMessageId(SessionId('different-owner'), routine, request)).not.toBe(id)
    expect(routineTestMessageId(sessionId, 'other-routine', request)).not.toBe(id)
  })

  it('reports pending, claimed and canceled inbox deliveries independently', () => {
    const session = reserve()
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    expect(status(session)).toBe('interrupted')
    expect(routineTestRunFromEvents(session.snapshotEvents(), 'different-routine')).toBeUndefined()
    expect(routineTestRunFromEvents(session.snapshotEvents(), routine, MessageId('unrecorded'))).toBeUndefined()
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    expect(status(session)).toBe('queued')
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    expect(status(session)).toBe('running')
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    expect(status(session)).toBe('canceled')
  })

  const cases = [
    [{ kind: 'completed' }, 'completed'],
    [{ kind: 'aborted', reason: { kind: 'legacy' } }, 'canceled'],
    [{ kind: 'interrupted' }, 'interrupted'],
    [{ kind: 'blocked' }, 'failed'],
  ] as const satisfies readonly [SessionEventMap['turn/end']['reason'], string][]

  it.each(cases)('reads %o only from the turn that received the test', (reason, expected) => {
    const session = reserve()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', freezeMessage({
      id: MessageId('ordinary-user-message'), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'An independent turn.' }],
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(status(session)).toBe('running')
    session.append('turn/end', { turn: 2, reason })
    expect(status(session)).toBe(expected)
    expect(routineTestRunFromEvents(session.snapshotEvents(), routine)?.messageId).toBe(id)
  })
})
