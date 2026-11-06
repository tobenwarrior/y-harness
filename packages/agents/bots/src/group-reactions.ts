/** Reaction choices shared by the Host validator and Client picker. */

/** Fixed emoji choices supported by durable Bot group reactions. */
export const BOT_GROUP_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'] as const

/** Stable reaction identity from the fixed group emoji palette. */
export type BotGroupReactionEmoji = typeof BOT_GROUP_REACTION_EMOJIS[number]
