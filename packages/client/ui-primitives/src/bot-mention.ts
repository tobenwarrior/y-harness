/** Inline Bot references stored in user-message text. */

const BOT_MENTION = /@\[((?:\\[\\\]@:rn]|[^\\\]@:\r\n])+)\]\(dsh-bot:(bot-[A-Za-z0-9][A-Za-z0-9-]*)\)/gu
const BOT_GROUP_MENTION = /@\[((?:\\[\\\]@:rn]|[^\\\]@:\r\n])+)\]\(dsh-bot-group:(bot-group-[A-Za-z0-9][A-Za-z0-9-]*)\)/gu

/** A Bot id paired with its mention-time display label. */
export interface BotMention {
  readonly botId: string
  readonly label: string
}

/** A Bot group id paired with its mention-time display label. */
export interface BotGroupMention {
  readonly groupId: string
  readonly label: string
}

function encodeMentionLabel(label: string): string {
  return label.replace(/[\\\]@:]/gu, '\\$&').replaceAll('\r', '\\r').replaceAll('\n', '\\n')
}

function decodeMentionLabel(escaped: string): string {
  return escaped.replace(/\\([\\\]@:rn])/gu, (_escape, character: string) =>
    character === 'r' ? '\r' : character === 'n' ? '\n' : character)
}

/**
 * Encode a selected Bot as an inline mention.
 * @param botId - validated stable Bot id.
 * @param label - display name.
 * @returns the mention stored in message text.
 */
export function formatBotMention(botId: string, label: string): string {
  return `@[${encodeMentionLabel(label)}](dsh-bot:${botId})`
}

/**
 * Encode a selected Bot group as an inline mention.
 * @param groupId - validated stable Bot group id.
 * @param label - display name.
 * @returns the mention stored in message text.
 */
export function formatBotGroupMention(groupId: string, label: string): string {
  return `@[${encodeMentionLabel(label)}](dsh-bot-group:${groupId})`
}

/**
 * Parse a standalone Bot mention.
 * @param mention - complete candidate text.
 * @returns the Bot id and label, or undefined for other text.
 */
export function parseBotMention(mention: string): BotMention | undefined {
  const first = botMentionsIn(mention).next().value
  return first?.text === mention ? { botId: first.botId, label: first.label } : undefined
}

/**
 * Parse a standalone Bot group mention.
 * @param mention - complete candidate text.
 * @returns the Bot group id and label, or undefined for other text.
 */
export function parseBotGroupMention(mention: string): BotGroupMention | undefined {
  const first = botGroupMentionsIn(mention).next().value
  return first?.text === mention ? { groupId: first.groupId, label: first.label } : undefined
}

/**
 * Locate canonical Bot mentions without touching other reference forms.
 * @param text - message text.
 * @returns canonical mentions and their original spans.
 */
export function* botMentionsIn(text: string): Generator<BotMention & { index: number; text: string }, void> {
  for (const match of text.matchAll(BOT_MENTION)) {
    const [, escaped = '', botId = ''] = match
    yield { botId, label: decodeMentionLabel(escaped), index: match.index, text: match[0] }
  }
}

/**
 * Locate canonical group references in user-message text.
 * @param text - Message text.
 * @returns Group references with their original text spans.
 */
export function* botGroupMentionsIn(text: string): Generator<BotGroupMention & { index: number; text: string }, void> {
  for (const match of text.matchAll(BOT_GROUP_MENTION)) {
    const [, escaped = '', groupId = ''] = match
    yield { groupId, label: decodeMentionLabel(escaped), index: match.index, text: match[0] }
  }
}
