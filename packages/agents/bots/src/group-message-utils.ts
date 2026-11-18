/** Shared durable group-message projections for owner-local and shared groups. */

import type {
  BotGroupDeliveryRecord,
  BotGroupId,
  BotGroupMessageId,
  BotGroupMessageRecord,
  BotGroupMessageSenderView,
  BotGroupMessageReplyView,
  BotGroupReactionView,
} from './group-chat.ts'
import type { BotId, BotView } from './types.ts'

const MAX_REPLY_CONTEXT_TEXT = 480

type GroupMessageViewBase = {
  readonly id: BotGroupMessageId
  readonly groupId: BotGroupId
  readonly text: string
  readonly targetBotIds?: readonly BotId[]
  readonly replyToMessageId?: BotGroupMessageId
  readonly replyTo?: BotGroupMessageReplyView
  readonly reactions?: readonly BotGroupReactionView[]
  readonly createdAt: number
}

/** Resolve a message's original recipient set from its durable delivery rows.
 * @param message - Stored group message whose recipients are being resolved.
 * @param deliveries - Durable delivery rows for the group message.
 * @returns The stored or reconstructed recipient order, or undefined when no recipients are known.
 */
export function persistedGroupTargetBotIds(
  message: Pick<BotGroupMessageRecord, 'groupId' | 'id' | 'targetBotIds'>,
  deliveries: readonly Pick<BotGroupDeliveryRecord, 'groupId' | 'messageId' | 'botId'>[],
): readonly BotId[] | undefined {
  if (message.targetBotIds !== undefined) return message.targetBotIds
  const ids = deliveries
    .filter(delivery => delivery.groupId === message.groupId && delivery.messageId === message.id)
    .map(delivery => delivery.botId)
  if (ids.length === 0) return undefined
  return [...new Map(ids.map(botId => [String(botId), botId])).values()]
}

/** Resolve the sender projection used by both group transcript consumers.
 * @param message - Stored group message whose sender is being projected.
 * @param bots - Current Bot roster used to resolve a sender name.
 * @returns A safe sender projection with a fallback name for removed Bots.
 */
export function groupMessageSenderView(
  message: Pick<BotGroupMessageRecord, 'sender' | 'senderName'>,
  bots: readonly BotView[],
): BotGroupMessageSenderView {
  const sender = message.sender
  if (sender.kind === 'user') return sender
  const bot = bots.find(candidate => candidate.id === sender.botId)
  return { kind: 'bot', botId: sender.botId, name: message.senderName ?? bot?.name ?? String(sender.botId) }
}

/** Build the common durable fields for one group transcript row.
 * @param message - Stored group message being projected.
 * @param replyView - Resolved parent message, when one exists.
 * @param reactions - Visible reaction projections for the current viewer.
 * @returns The shared transcript fields before sender and attachments are added.
 */
export function groupMessageViewBase(
  message: Pick<BotGroupMessageRecord, 'id' | 'groupId' | 'text' | 'targetBotIds' | 'replyToMessageId' | 'createdAt'>,
  replyView: BotGroupMessageReplyView | undefined,
  reactions: readonly BotGroupReactionView[],
): GroupMessageViewBase {
  return {
    id: message.id,
    groupId: message.groupId,
    text: message.text,
    ...(message.targetBotIds === undefined ? {} : { targetBotIds: message.targetBotIds }),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    ...(replyView === undefined ? {} : { replyTo: replyView }),
    ...(reactions.length === 0 ? {} : { reactions }),
    createdAt: message.createdAt,
  }
}

/** Bound quoted reply text before it is added to model-visible delivery context.
 * @param value - Stored message text.
 * @returns The original text or a bounded excerpt with an ellipsis.
 */
export function boundedGroupReplyText(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= MAX_REPLY_CONTEXT_TEXT) return value
  return `${characters.slice(0, MAX_REPLY_CONTEXT_TEXT - 1).join('')}…`
}
