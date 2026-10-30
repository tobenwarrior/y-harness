import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('ships one English dictionary and keeps the retired locale alias compatible', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').id).toBe('en')
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(en)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it.each([undefined, 'Y Harness', 'Atlas', 'Atlas $& $`'])('names the application in listener-conflict guidance for %s', (displayName) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
    const name = displayName ?? 'Y Harness'
    const english = resolveDesktopLocale('en-US').messages
    expect(english.startupAddressInUse).toBe(`Another ${name} instance (such as the web or desktop app) is running. They cannot start at the same time. Quit the other running ${name} instance, then restart.`)
    expect(english.cliCommandTitle).toBe(`Manage ${name} CLI`)
    expect(english.welcomeKeyDescription).toContain('official DeepSeek models')
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('uses a custom display label without changing the shipped dictionary', () => {
    const english = resolveDesktopLocale('en-US', 'Atlas').messages
    expect(english).toMatchObject({ aboutMenu: 'About Atlas', aboutProduct: 'Atlas',
      hideApplication: 'Hide Atlas', openApplication: 'Open Atlas', quitTitle: 'Quit Atlas?',
      welcomeTitle: 'Atlas', welcomeKeyDescription: 'Configure official DeepSeek models to start using Atlas',
      updateTitle: 'Atlas Update' })
    expect(english.cliCommandTitle).toBe('Manage Atlas CLI')
    expect(english.aboutVersion).toBe('Version V{version}')
    expect(en.aboutProduct).toBe('Y Harness')
    expect(zh.aboutProduct).toBe('Y Harness')
  })

  it('resolves the configured display label from the public client environment', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    expect(resolveDesktopLocale('en-US').messages.aboutProduct).toBe('Atlas')
    expect(resolveDesktopStartupLocale(null, ['zh-CN']).messages.aboutProduct).toBe('Atlas')
  })

  it('keeps replacement characters literal in the configured display label', () => {
    expect(resolveDesktopLocale('en-US', 'Atlas $&').messages.aboutMenu).toBe('About Atlas $&')
  })

  it('accepts legacy and unknown choices while always resolving the English shell', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('en')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('en')
  })

})
