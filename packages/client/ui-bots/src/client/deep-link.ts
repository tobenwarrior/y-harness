/** Bot links consumed by the Web entry point and native handoff. */
import type { BotId } from '@yharness/bots/client'
import { brandString } from '@yharness/brand'
import { isYHarnessCloudDesktop } from './bot-vault-request.ts'

/** Fragment route for Bot prompts. The prompt stays in the browser. */
export const BOT_PROMPT_FRAGMENT = '#/bots/prompt?'

/** Fragment route for opening an existing Bot chat. */
export const BOT_CHAT_FRAGMENT = '#/bots/open?'

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

function chatTarget(id: string | undefined): Extract<BotPromptTarget, { kind: 'id' }> | undefined {
  if (id === undefined || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(id)) return undefined
  return { kind: 'id', id: brandString<BotId>(id) }
}

function readLinkParameters(
  url: URL, trustedOrigin: string, route: string, allowed: readonly string[],
): Map<string, string> | undefined {
  const desktop = url.protocol === 'dsh-app:' && url.host === 'app' && url.pathname === '/'
  const trusted = desktop
    ? trustedOrigin === 'dsh-app://app' || trustedOrigin === url.origin
    : (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === trustedOrigin
  if (!trusted || url.username !== '' || url.password !== '' || !url.hash.startsWith(route)) return undefined

  const fragment = url.hash.slice(route.length)
  if (fragment.includes('#')) return undefined
  const values = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(fragment)) {
    if (!allowed.includes(key) || values.has(key)) return undefined
    values.set(key, value)
  }
  return values
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
  const values = readLinkParameters(url, trustedOrigin, BOT_PROMPT_FRAGMENT, ['id', 'text'])
  if (values === undefined) return undefined
  const rawText = values.get('text')
  if (rawText === undefined || rawText.trim() === '' || Array.from(rawText).length > BOT_PROMPT_MAX_CODE_POINTS) return undefined
  const text = rawText.replace(/\r\n|[\r\n]/gu, ' ')
  const id = values.get('id')
  if (id === undefined) return { target: { kind: 'primary' }, text }
  const target = chatTarget(id)
  return target === undefined ? undefined : { target, text }
}

/**
 * Read the Bot id from a chat link; roster access is checked when opening it.
 * @param url - URL to validate.
 * @param trustedOrigin - exact origin currently serving the application.
 * @returns the selected Bot target or `undefined` when invalid.
 */
export function parseBotChatUrl(url: URL, trustedOrigin: string): BotPromptTarget | undefined {
  return chatTarget(readLinkParameters(url, trustedOrigin, BOT_CHAT_FRAGMENT, ['id'])?.get('id'))
}

/**
 * Build a chat address from the current application mount.
 * @param activeUrl - application page, which may carry query credentials or a pending prompt.
 * @param id - selected Bot id.
 * @param userAgent - recognizes a Cloud page embedded inside Desktop.
 * @returns the same application and Bot address with all current URL parameters removed.
 */
export function botChatLink(activeUrl: URL, id: string, userAgent: string): string {
  const parameters = new URLSearchParams({ id })
  if (activeUrl.protocol === 'dsh-app:' || isYHarnessCloudDesktop(userAgent)) {
    return `dsh://bots/open?${parameters.toString()}`
  }
  const url = new URL(activeUrl.origin)
  url.pathname = activeUrl.pathname
  url.hash = `${BOT_CHAT_FRAGMENT}${parameters.toString()}`
  return url.href
}
