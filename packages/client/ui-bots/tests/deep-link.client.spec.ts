import { describe, expect, it } from 'vitest'
import {
  BOT_PROMPT_MAX_CODE_POINTS,
  BOT_PROMPT_FRAGMENT,
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
