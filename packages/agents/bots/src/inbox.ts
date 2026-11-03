import type { UserMessage } from '@yharness/llm'
import type { MessageId } from '@yharness/llm/brand'
import type { SessionEvent } from '@yharness/session'

/** Durable outcome of one Bot inbox message, including messages no longer pending. */
export type BotInboxMessageDisposition = 'pending' | 'claimed' | 'canceled'

/** Message and durable inbox outcome reconstructed from splice history. */
export interface BotInboxMessageState {
  /** Latest message payload associated with the identity. */
  readonly message: UserMessage
  /** Whether the message remains queued, was claimed, or was canceled. */
  readonly disposition: BotInboxMessageDisposition
}

/**
 * Reconstruct one inbox message's durable state from normalized splice events.
 * @param events - Session events in durable order.
 * @param messageId - Message whose inbox state is requested.
 * @returns The latest state, or undefined when the message was not recorded.
 */
export function botInboxMessageState(
  events: readonly SessionEvent[],
  messageId: MessageId,
): BotInboxMessageState | undefined {
  const queues: { 'next-turn': UserMessage[]; 'next-step': UserMessage[] } = {
    'next-turn': [],
    'next-step': [],
  }
  const states = new Map<string, BotInboxMessageState>()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const queue = queues[event.data.target]
    const removed = queue.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
    const disposition: BotInboxMessageDisposition = event.data.outcome === 'canceled' ? 'canceled' : 'claimed'
    for (const message of removed) states.set(String(message.id), { message, disposition })
    for (const message of event.data.inserted) {
      states.set(String(message.id), { message, disposition: 'pending' })
    }
  }
  return states.get(String(messageId))
}
