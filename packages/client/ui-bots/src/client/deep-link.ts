/** Safe, transport-neutral Bot prompt intents used by the Web entry point and native handoff. */
import type { BotId } from '@yharness/bots/client'
import { brandString } from '@yharness/brand'

/** Fragment route for Bot prompts. The prompt stays in the browser. */
export const BOT_PROMPT_FRAGMENT = '#/bots/prompt?'

/** Maximum prompt length accepted from a deep link, measured in Unicode code points. */
export const BOT_PROMPT_MAX_CODE_POINTS = 1_000

/** The Bot selected by a prompt deep link. */
export type BotPromptTarget =
  | { readonly kind: 'id'; readonly id: BotId }
  | { readonly kind: 'primary' }

/** A validated prompt request that may be handed to the Bot workspace. */
export interface BotPromptIntent {
  readonly target: BotPromptTarget
  readonly text: string
}

/** Parse one trusted Web URL into a Bot prompt intent.
 *
 * Omitting `id` addresses the primary Bot in the signed-in workspace. Prompt
 * text lives in the fragment, which stays out of HTTP requests.
 *
 * @param url - URL to validate.
 * @param trustedOrigin - exact origin currently serving the application.
 * @returns the validated intent, or `undefined` when the URL is not ours.
 */
export function parseBotPromptUrl(url: URL, trustedOrigin: string): BotPromptIntent | undefined {
  const desktop = url.protocol === 'dsh-app:' && url.host === 'app' && url.pathname === '/'
  const trusted = desktop
    ? trustedOrigin === 'dsh-app://app' || trustedOrigin === url.origin
    : (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === trustedOrigin
  if (!trusted) return undefined
  if (url.username !== '' || url.password !== '' || !url.hash.startsWith(BOT_PROMPT_FRAGMENT)) return undefined

  const fragment = url.hash.slice(BOT_PROMPT_FRAGMENT.length)
  if (fragment.includes('#')) return undefined
  const values = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(fragment)) {
    if (key !== 'id' && key !== 'text') return undefined
    if (values.has(key)) return undefined
    values.set(key, value)
  }

  const rawText = values.get('text')
  if (rawText === undefined || rawText.trim() === '' || Array.from(rawText).length > BOT_PROMPT_MAX_CODE_POINTS) return undefined
  const text = rawText.replace(/\r\n|[\r\n]/gu, ' ')
  const id = values.get('id')
  if (id === undefined) return { target: { kind: 'primary' }, text }
  if (!/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(id)) return undefined
  return { target: { kind: 'id', id: brandString<BotId>(id) }, text }
}
