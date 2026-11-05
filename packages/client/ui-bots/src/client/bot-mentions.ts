/** Find and route explicit Bot mentions in group messages. */

/**
 * Find the partial mention at the current cursor.
 * @param text - Composer text.
 * @param cursor - Current cursor offset.
 * @returns The partial mention or null.
 */
export function mentionQueryAt(text: string, cursor: number): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor))
  return match === null ? null : match[1] ?? ''
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find Bots mentioned by their full names.
 * @param text - Message text.
 * @param bots - Bots visible in the current group.
 * @returns Mentioned Bot IDs.
 */
export function mentionTargets(text: string, bots: readonly { readonly id: string; readonly name: string }[]): readonly string[] {
  return bots.flatMap((bot) => {
    const name = escapeName(bot.name)
    const pattern = new RegExp(`(?:^|\\s)@${name}(?=$|[\\s.,!?;:])`, 'iu')
    return pattern.test(text) ? [bot.id] : []
  })
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
  selections: readonly { readonly id: string; readonly name: string }[],
): readonly string[] | undefined {
  const known = [...bots, ...selections]
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/gu)) {
    const query = (match[1] ?? '').replace(/[.,!?;:]+$/u, '').toLocaleLowerCase()
    if (query === '') continue
    const tail = text.slice(match.index + match[0].indexOf('@'))
    const possible = known.some(bot => bot.name.toLocaleLowerCase().startsWith(query))
    const complete = known.some(bot => new RegExp(`^@${escapeName(bot.name)}(?=$|[\\s.,!?;:])`, 'iu').test(tail))
    if (possible && !complete) return undefined
  }
  const active = selections.filter(selection => mentionTargets(text, [selection]).length > 0)
  if (active.some(selection => !bots.some(bot => bot.id === selection.id))) return undefined
  const selectedByName = new Map(active.map(selection => [selection.name.toLocaleLowerCase(), selection.id]))
  const mentioned = new Set(mentionTargets(text, bots))
  const result = new Set(active.map(selection => selection.id))
  for (const bot of bots) {
    if (!mentioned.has(bot.id)) continue
    const name = bot.name.toLocaleLowerCase()
    if (selectedByName.has(name)) continue
    if (bots.filter(candidate => candidate.name.toLocaleLowerCase() === name).length > 1) return undefined
    result.add(bot.id)
  }
  return [...result]
}
