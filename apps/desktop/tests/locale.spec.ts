import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('uses a custom display label in both locales without changing the shipped dictionaries', () => {
    const english = resolveDesktopLocale('en-US', 'Atlas').messages
    const chinese = resolveDesktopLocale('zh-CN', 'Atlas').messages
    expect(english).toMatchObject({ aboutMenu: 'About Atlas', aboutProduct: 'Atlas',
      hideApplication: 'Hide Atlas', openApplication: 'Open Atlas', quitTitle: 'Quit Atlas?',
      welcomeTitle: 'Atlas', welcomeKeyDescription: 'Configure official DeepSeek models to start using Atlas',
      updateTitle: 'Atlas Update' })
    expect(chinese).toMatchObject({ aboutMenu: '关于 Atlas', aboutProduct: 'Atlas',
      hideApplication: '隐藏 Atlas', openApplication: '打开 Atlas', quitTitle: '退出 Atlas？',
      welcomeTitle: 'Atlas', updateTitle: 'Atlas 更新' })
    expect(english.cliCommandTitle).toBe('Manage dsh Command')
    expect(english.aboutVersion).toBe('Version V{version}')
    expect(en.aboutProduct).toBe('Y harness')
    expect(zh.aboutProduct).toBe('Y harness')
  })

  it('resolves the configured display label from the public client environment', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    expect(resolveDesktopLocale('en-US').messages.aboutProduct).toBe('Atlas')
    expect(resolveDesktopStartupLocale(null, ['zh-CN']).messages.aboutProduct).toBe('Atlas')
  })

  it('keeps replacement characters literal in the configured display label', () => {
    expect(resolveDesktopLocale('en-US', 'Atlas $&').messages.aboutMenu).toBe('About Atlas $&')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('zh-CN')
  })

})
