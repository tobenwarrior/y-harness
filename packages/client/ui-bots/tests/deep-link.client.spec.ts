import { describe, expect, it } from 'vitest'
import {
  BOT_PROMPT_MAX_CODE_POINTS,
  BOT_PROMPT_FRAGMENT,
  botChatLink,
  parseBotChatUrl,
  parseBotPromptUrl,
} from '../src/client/deep-link.ts'

const ORIGIN = 'https://harness.test'

function promptUrl(parameters: string, path = '/'): URL {
  return new URL(`${ORIGIN}${path}${BOT_PROMPT_FRAGMENT}${parameters}`)
}

describe('Bot prompt deep links', () => {
  it('targets an explicit active Bot id and preserves Unicode prompt text', () => {
    expect(parseBotPromptUrl(promptUrl('id=bot-scout-1&text=Review%20%E2%98%95'), ORIGIN)).toEqual({
      target: { kind: 'id', id: 'bot-scout-1' }, text: 'Review ☕',
    })
  })

  it('targets the configured primary Bot when id is omitted', () => {
    expect(parseBotPromptUrl(promptUrl('text=Check%20the%20queue'), ORIGIN)).toEqual({
      target: { kind: 'primary' }, text: 'Check the queue',
    })
    expect(parseBotPromptUrl(promptUrl('text=Check%0D%0Athe%0Aqueue', '/mounted/'), ORIGIN)).toEqual({
      target: { kind: 'primary' }, text: 'Check the queue',
    })
  })

  it('accepts the packaged desktop page and rejects other origins on its scheme', () => {
    const desktop = new URL(`dsh-app://app/${BOT_PROMPT_FRAGMENT}text=Check%20the%20queue`)
    expect(parseBotPromptUrl(desktop, 'dsh-app://app')).toEqual({
      target: { kind: 'primary' }, text: 'Check the queue',
    })
    expect(parseBotPromptUrl(desktop, desktop.origin)?.text).toBe('Check the queue')
    expect(parseBotPromptUrl(desktop, ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(new URL(`dsh-app://other/${BOT_PROMPT_FRAGMENT}text=hello`), 'null')).toBeUndefined()
  })

  it('ignores other origins, unrelated fragments, addresses with credentials, and ambiguous parameters', () => {
    expect(parseBotPromptUrl(promptUrl('text=hello'), 'https://other.test')).toBeUndefined()
    expect(parseBotPromptUrl(new URL('file:///#/bots/prompt?text=hello'), 'null')).toBeUndefined()
    expect(parseBotPromptUrl(new URL('https://user:pass@harness.test/#/bots/prompt?text=hello'), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(new URL(`${ORIGIN}/?text=hello#section`), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(promptUrl('text=hello#section'), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(promptUrl('text=hello&send=true'), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(promptUrl('text=hello&text=again'), ORIGIN)).toBeUndefined()
  })

  it('rejects blank prompts, invalid Bot ids, and prompts longer than 1,000 code points', () => {
    expect(parseBotPromptUrl(promptUrl(''), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(promptUrl('text=%20'), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(promptUrl('id=&text=hello'), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(promptUrl('id=%20bot-scout&text=hello'), ORIGIN)).toBeUndefined()
    expect(parseBotPromptUrl(promptUrl('id=bot-scout%00&text=hello'), ORIGIN)).toBeUndefined()
    const limit = '😀'.repeat(BOT_PROMPT_MAX_CODE_POINTS)
    expect(parseBotPromptUrl(promptUrl(`text=${encodeURIComponent(limit)}`), ORIGIN)?.text).toBe(limit)
    expect(parseBotPromptUrl(promptUrl(`text=${encodeURIComponent(`${limit}😀`)}`), ORIGIN)).toBeUndefined()
  })
})

describe('Bot chat links', () => {
  it('copies a same-origin chat address without the current query, credentials, or draft', () => {
    const active = new URL('https://user:password@harness.test/workspace/?token=private#/bots/prompt?text=secret')
    const copied = botChatLink(active, 'bot-scout-1', '')
    expect(copied).toBe('https://harness.test/workspace/#/bots/open?id=bot-scout-1')
    expect(parseBotChatUrl(new URL(copied), ORIGIN)).toEqual({ kind: 'id', id: 'bot-scout-1' })
    const mounted = new URL('https://harness.test//workspace.test/')
    expect(new URL(botChatLink(mounted, 'bot-scout', '')).origin).toBe(ORIGIN)
  })

  it('copies a native chat address from Mac and Cloud', () => {
    const native = 'dsh://bots/open?id=bot-scout'
    expect(botChatLink(new URL('dsh-app://app/'), 'bot-scout', '')).toBe(native)
    const cloud = new URL('http://127.0.0.1:12345/?token=private')
    expect(botChatLink(cloud, 'bot-scout', 'Chrome YHarnessCloudDesktop/1')).toBe(native)
  })

  it.each([
    '', 'id=wrong', 'id=bot-scout&text=hello', 'id=bot-scout&id=bot-other',
    'id=bot-scout#unknown', 'id=bot-scout&token=private',
  ])('ignores incomplete or ambiguous chat links: %s', (parameters) => {
    expect(parseBotChatUrl(new URL(`${ORIGIN}/#/bots/open?${parameters}`), ORIGIN)).toBeUndefined()
  })

  it('rejects a chat link from a different origin and a prompt fragment', () => {
    expect(parseBotChatUrl(new URL(`${ORIGIN}/#/bots/open?id=bot-scout`), 'https://other.test')).toBeUndefined()
    expect(parseBotChatUrl(promptUrl('id=bot-scout&text=hello'), ORIGIN)).toBeUndefined()
  })
})
