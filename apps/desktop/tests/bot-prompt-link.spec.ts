import { describe, expect, it } from 'vitest'
import {
  DESKTOP_BOT_PROMPT_QUERY_LIMIT,
  DESKTOP_BOT_PROMPT_ROUTE,
  desktopOpenUrlFromArgs,
  routeDesktopBotPrompt,
} from '../src/bot-prompt-link.ts'

describe('desktop Bot prompt links', () => {
  it('selects an admitted URL from OS arguments and ignores unsupported schemes and flags', () => {
    const link = `${DESKTOP_BOT_PROMPT_ROUTE}?text=Review`
    expect(desktopOpenUrlFromArgs(['desktop', '--updated', `${DESKTOP_BOT_PROMPT_ROUTE}?send=true`, link]))
      .toBe(link)
    expect(desktopOpenUrlFromArgs(['desktop', 'dsh://open/'])).toBe('dsh://open/')
    expect(desktopOpenUrlFromArgs(['desktop', '--launch=' + link, 'https://example.test'])).toBeUndefined()
  })

  it('routes an admitted prompt to the private application document', () => {
    expect(routeDesktopBotPrompt(`${DESKTOP_BOT_PROMPT_ROUTE}?id=bot-scout&text=Review%20the%20queue`))
      .toBe('dsh-app://app/#/bots/prompt?id=bot-scout&text=Review%20the%20queue')
  })

  it('keeps the primary Bot request addressable without an id', () => {
    expect(routeDesktopBotPrompt(`${DESKTOP_BOT_PROMPT_ROUTE}?text=Check%20the%20queue`))
      .toBe('dsh-app://app/#/bots/prompt?text=Check%20the%20queue')
  })

  it('routes a Bot chat link from the OS without admitting composer text', () => {
    const link = 'dsh://bots/open?id=bot-scout'
    expect(desktopOpenUrlFromArgs(['desktop', link])).toBe(link)
    expect(routeDesktopBotPrompt(link)).toBe('dsh-app://app/#/bots/open?id=bot-scout')
    expect(routeDesktopBotPrompt(link + '&text=hello')).toBeUndefined()
    expect(routeDesktopBotPrompt(link + '&id=bot-other')).toBeUndefined()
    expect(routeDesktopBotPrompt('dsh://bots/open?id=')).toBeUndefined()
  })

  it.each([
    'dsh://open?text=hello',
    'dsh://bots/other?text=hello',
    'https://bots/prompt?text=hello',
    'dsh://user:pass@bots/prompt?text=hello',
    'dsh://bots:443/prompt?text=hello',
    'dsh://bots/prompt?text=hello#section',
    'dsh://bots/prompt?text=hello&unknown=value',
    'dsh://bots/prompt?text=hello&text=again',
    'dsh://bots/prompt?id=scout&text=',
    'dsh://bots/prompt?id=scout',
  ])('rejects an invalid transport link: %s', (link) => {
    expect(routeDesktopBotPrompt(link)).toBeUndefined()
  })

  it('bounds the encoded query before handing it to the renderer', () => {
    const oversized = `${DESKTOP_BOT_PROMPT_ROUTE}?text=${'a'.repeat(DESKTOP_BOT_PROMPT_QUERY_LIMIT)}`
    expect(routeDesktopBotPrompt(oversized)).toBeUndefined()
  })
})
