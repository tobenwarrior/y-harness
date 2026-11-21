/** Durable reservation and turn status for an owner-started Bot routine test. */

import { createHash } from 'node:crypto'
import { MessageId } from '@yharness/llm/brand'
import type { SessionEvent, SessionId } from '@yharness/session/types'
import { botInboxMessageState } from './inbox.ts'
import type { BotRoutineTestId, BotRoutineTestRun } from './types.ts'

declare module '@yharness/session/types' {
  interface SessionEventMap {
    /** The Host reserved one explicit attempt before invoking the Agent. */
    'bot/routine-test': {
      readonly routineId: string
      readonly messageId: MessageId
    }
  }
}

/**
 * Derive the Session-local message that identifies a retry of the same request.
 * @param sessionId - The owning Bot Session.
 * @param routineId - The saved routine.
 * @param requestId - Stable request identity supplied by the client.
 * @returns The message identity reserved by the Host.
 */
export function routineTestMessageId(sessionId: SessionId, routineId: string, requestId: BotRoutineTestId): MessageId {
  const digest = createHash('sha256').update(JSON.stringify([sessionId, routineId, requestId])).digest('hex')
  return MessageId('bot-routine-test-' + digest)
}

/**
 * Reconstruct the latest or exact test attempt using its inbox and owning turn.
 * @param events - Canonical events from the Bot Session.
 * @param routineId - The routine whose test was requested.
 * @param messageId - An exact attempt identity, when replaying a request.
 * @returns Test state, or undefined when the matching attempt was never reserved.
 */
export function routineTestRunFromEvents(
  events: readonly SessionEvent[],
  routineId: string,
  messageId?: MessageId,
): BotRoutineTestRun | undefined {
  const reservation = events.findLast(event => event.type === 'bot/routine-test'
    && event.data.routineId === routineId && (messageId === undefined || event.data.messageId === messageId))
  if (reservation?.type !== 'bot/routine-test') return undefined
  const id = reservation.data.messageId
  const run = { messageId: id, requestedAt: reservation.time }
  let openTurn: number | undefined
  let owningTurn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = event.data.turn
    if (event.type === 'user/message' && event.data.id === id && event.data.source.kind === 'schedule' && event.data.source.invocation === 'test') {
      owningTurn = openTurn
    }
    if (event.type === 'turn/end') {
      if (event.data.turn === owningTurn) {
        const reason = event.data.reason.kind
        return { ...run, status: reason === 'completed' ? 'completed'
          : reason === 'aborted' ? 'canceled' : reason === 'interrupted' ? 'interrupted' : 'failed' }
      }
      if (event.data.turn === openTurn) openTurn = undefined
    }
  }
  if (owningTurn !== undefined) return { ...run, status: 'running' }
  const inbox = botInboxMessageState(events, id)
  switch (inbox?.disposition) {
    case 'pending': return { ...run, status: 'queued' }
    case 'claimed': return { ...run, status: 'running' }
    case 'canceled': return { ...run, status: 'canceled' }
    case undefined: return { ...run, status: 'interrupted' }
  }
}
