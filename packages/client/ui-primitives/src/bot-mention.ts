/** Inline Bot references stored in user-message text. */

const BOT_MENTION = /@\[((?:\\[\\\]@:rn]|[^\\\]@:\r\n])+)\]\(dsh-bot:(bot-[A-Za-z0-9][A-Za-z0-9-]*)\)/gu

/** A Bot id paired with its mention-time display label. */
export interface BotMention {
  readonly botId: string
  readonly label: string
}

/**
 * Encode a selected Bot as an inline mention.
 * @param botId - validated stable Bot id.
 * @param label - display name.
 * @returns the mention stored in message text.
 */
export function formatBotMention(botId: string, label: string): string {
  const escaped = label.replace(/[\\\]@:]/gu, '\\$&').replaceAll('\r', '\\r').replaceAll('\n', '\\n')
  return `@[${escaped}](dsh-bot:${botId})`
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
 * Locate canonical Bot mentions without touching other reference forms.
 * @param text - message text.
 * @returns canonical mentions and their original spans.
 */
export function* botMentionsIn(text: string): Generator<BotMention & { index: number; text: string }, void> {
  for (const match of text.matchAll(BOT_MENTION)) {
    const [, escaped = '', botId = ''] = match
    const label = escaped.replace(/\\([\\\]@:rn])/gu, (_escape, character: string) =>
      character === 'r' ? '\r' : character === 'n' ? '\n' : character)
    yield { botId, label, index: match.index, text: match[0] }
  }
}
