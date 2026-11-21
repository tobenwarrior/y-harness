/** Find and route explicit Bot mentions in group messages. */

/** Reserved mention label for addressing every Bot in the current group. */
export const EVERYONE_MENTION = 'everyone'

/** One explicit mention selection retained by a group composer. */
export type BotMentionSelection =
  | { readonly id: string; readonly name: string }
  | { readonly kind: 'everyone' }

/**
 * Find the partial mention at the current cursor.
 * @param text - Composer text.
 * @param cursor - Current cursor offset.
 * @returns The partial mention or null.
 */
export function mentionQueryAt(text: string, cursor: number): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor))
  return match === null ? null : match[1] as string
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
}

function completeMention(tail: string, name: string): boolean {
  return new RegExp('^@' + escapeName(name) + '(?=$|[\\s.,!?;:])', 'iu').test(tail)
}

/**
 * Check whether a complete named mention remains in composer text.
 * @param text - Composer text.
 * @param name - Mention name to find.
 * @returns Whether the text contains a complete mention token.
 */
export function hasCompleteMention(text: string, name: string): boolean {
  return new RegExp('(?:^|\\s)@' + escapeName(name) + '(?=$|[\\s.,!?;:])', 'iu').test(text)
}

/**
 * Remove complete occurrences of one named mention from composer text.
 * @param text - Composer text.
 * @param name - Mention name to remove.
 * @returns Text with the selected mention token removed and spacing normalized.
 */
export function removeCompleteMention(text: string, name: string): string {
  return text
    .replace(new RegExp('(^|\\s)@' + escapeName(name) + '(?=$|[\\s.,!?;:])', 'giu'), '$1')
    .replace(/^[ \t]+/u, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+([.,!?;:])/gu, '$1')
}

/**
 * Find Bots mentioned by their full names.
 * @param text - Message text.
 * @param bots - Bots visible in the current group.
 * @returns Mentioned Bot IDs.
 */
export function mentionTargets(text: string, bots: readonly { readonly id: string; readonly name: string }[]): readonly string[] {
  const matches = bots.flatMap((bot) => {
    const pattern = new RegExp('(?:^|\\s)@' + escapeName(bot.name) + '(?=$|[\\s.,!?;:])', 'giu')
    return [...text.matchAll(pattern)].map(match => ({ bot, start: match.index + match[0].indexOf('@') }))
  })
  return bots.flatMap(bot => matches.some(match => (
    match.bot.id === bot.id
    && !matches.some(longer => (
      longer.start === match.start && longer.bot.name.length > match.bot.name.length
    ))
  )) ? [bot.id] : [])
}

/**
 * Resolve explicit selections and unambiguous typed mentions.
 * @param text - Message text.
 * @param bots - Current group roster.
 * @param selections - Explicitly selected mentions.
 * @returns Exact recipients, or undefined when a mention is ambiguous or stale.
 */
export function resolveMentionTargets(
  text: string,
  bots: readonly { readonly id: string; readonly name: string }[],
  selections: readonly BotMentionSelection[],
): readonly string[] | undefined {
  const everyoneSelected = selections.some(selection => 'kind' in selection)
  const known = [...bots, ...selections.filter((selection): selection is { readonly id: string; readonly name: string } => !('kind' in selection))]
  const everyoneBotSelected = selections.some(selection => (
    !('kind' in selection) && selection.name.toLocaleLowerCase() === EVERYONE_MENTION
  ))
  let everyoneBroadcastMentioned = false
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/gu)) {
    const query = (match[1] as string).replace(/[.,!?;:]+$/u, '').toLocaleLowerCase()
    if (query === '') continue
    const tail = text.slice(match.index + match[0].indexOf('@'))
    const possible = known.some(bot => bot.name.toLocaleLowerCase().startsWith(query))
    const complete = known.some(bot => completeMention(tail, bot.name))
    if (EVERYONE_MENTION.startsWith(query)) {
      // A complete named match wins over the reserved prefix. This keeps
      // names such as "Eve" and "Eve Research" addressable while reserving
      // the exact bare @everyone token for the explicit broadcast option.
      if (query !== EVERYONE_MENTION) {
        if (!complete) return undefined
      } else {
        const completeNonEveryone = known.some(bot => (
          bot.name.toLocaleLowerCase() !== EVERYONE_MENTION && completeMention(tail, bot.name)
        ))
        if (!completeNonEveryone) {
          if (!everyoneSelected && !everyoneBotSelected) return undefined
          if (everyoneSelected) everyoneBroadcastMentioned = true
        }
        continue
      }
    }
    if (possible && !complete) return undefined
  }
  const active = selections.filter((selection): selection is { readonly id: string; readonly name: string } => (
    !('kind' in selection) && mentionTargets(text, [selection]).length > 0
  ))
  if (active.some(selection => !bots.some(bot => bot.id === selection.id))) return undefined
  const selectedByName = new Map(active.map(selection => [selection.name.toLocaleLowerCase(), selection.id]))
  const mentioned = new Set(mentionTargets(text, bots))
  const result = new Set(active.map(selection => selection.id))
  if (everyoneBroadcastMentioned) {
    for (const bot of bots) result.add(bot.id)
  }
  for (const bot of bots) {
    if (!mentioned.has(bot.id)) continue
    const name = bot.name.toLocaleLowerCase()
    if (selectedByName.has(name)) continue
    if (bots.filter(candidate => candidate.name.toLocaleLowerCase() === name).length > 1) return undefined
    result.add(bot.id)
  }
  return [...result]
}
