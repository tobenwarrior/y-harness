import type { BotGroupReactionSummary } from './types.ts'

const GROUP_MESSAGE_ID = /^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/u
const REACTION_MAX_LENGTH = 16
const REACTION_MAX_COUNT = 100_000

const REACTION_PALETTE: Record<BotGroupReactionSummary['emoji'], true> = {
  '👍': true,
  '❤️': true,
  '😂': true,
  '🎉': true,
  '👀': true,
  '🙏': true,
}

/** Reactions supported by the compact group-message picker. */
export const GROUP_REACTION_OPTIONS = Object.keys(REACTION_PALETTE) as readonly BotGroupReactionSummary['emoji'][]

/**
 * Read the durable reply-parent id when it has the expected group-message format.
 * @param message - Local or wire-projected message to inspect.
 * @returns The reply-parent id, or `undefined` when the message is not a reply.
 */
export function readGroupReplyToMessageId(message: object): string | undefined {
  if (!('replyToMessageId' in message)) return undefined
  const value = message.replyToMessageId
  return typeof value === 'string' && GROUP_MESSAGE_ID.test(value) ? value : undefined
}

/**
 * Read safe reaction summaries from a local or wire-projected group message.
 * @param message - Local or wire-projected message to inspect.
 * @returns Supported reaction summaries with invalid entries omitted.
 */
export function readGroupReactions(message: object): readonly BotGroupReactionSummary[] {
  if (!('reactions' in message) || !Array.isArray(message.reactions)) return []
  return message.reactions.flatMap((item): readonly BotGroupReactionSummary[] => {
    if (!isRecord(item) || typeof item.emoji !== 'string' || item.emoji.length === 0 || item.emoji.length > REACTION_MAX_LENGTH
      || typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > REACTION_MAX_COUNT
      || (item.viewerReacted !== undefined && typeof item.viewerReacted !== 'boolean')) return []
    const emoji = GROUP_REACTION_OPTIONS.find(candidate => candidate === item.emoji)
    if (emoji === undefined) return []
    return [{
      emoji,
      count: item.count,
      ...(item.viewerReacted === undefined ? {} : { viewerReacted: item.viewerReacted }),
    }]
  })
}

/**
 * Normalize and bound text for a compact reply preview.
 * @param text - Original message text.
 * @param maxLength - Maximum preview length, defaulting to 140 characters.
 * @returns A whitespace-collapsed preview with an ellipsis when truncated.
 */
export function compactGroupQuote(text: string, maxLength = 140): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
