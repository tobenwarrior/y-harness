// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ThemeRuntime, type ThemeSettings } from '../src/client/index.ts'
import { bootThemeInjections } from '../src/boot-theme.ts'

afterEach(() => {
  document.body.removeAttribute('data-yh-style')
  document.body.removeAttribute('data-ds-dark-theme')
  document.body.style.removeProperty('--dsh-content-font-size')
  document.documentElement.removeAttribute('data-ds-theme-source')
})

describe('independent appearance style', () => {
  it('starts existing profiles in Default and persists style without changing color or content size', () => {
    const host = stubConfigForm<ThemeSettings>()
    const theme = new ThemeRuntime(new Context(), host.scope)
    expect(theme.getTheme().style).toBe('default')
    theme.setTheme('dark')
    theme.setFontSize(18)
    theme.setStyle('terminal')
    expect(theme.getTheme()).toMatchObject({ style: 'terminal', preference: 'dark', fontSize: 18 })
    expect(host.set).toHaveBeenLastCalledWith('style', 'terminal')
    host.set.mockClear()
    theme.setStyle('terminal')
    expect(host.set).not.toHaveBeenCalled()
    theme.setStyle('default')
    expect(theme.getTheme()).toMatchObject({ style: 'default', preference: 'dark', fontSize: 18 })
    expect(host.set).toHaveBeenCalledWith('style', 'default')
  })

  it('adopts persisted style without echoing a write, and preserves it across palette changes', () => {
    const host = stubConfigForm<ThemeSettings>()
    const theme = new ThemeRuntime(new Context(), host.scope)
    host.publish({ status: 'ready', value: { style: 'terminal', preference: 'system', fontSize: 22 }, revision: 1, writable: true })
    expect(theme.getTheme()).toMatchObject({ style: 'terminal', preference: 'system', fontSize: 22 })
    expect(host.set).not.toHaveBeenCalled()
    theme.setTheme('light')
    expect(theme.getTheme()).toMatchObject({ style: 'terminal', preference: 'light', fontSize: 22 })
  })

  it('seeds style from the Host boot selector before settings adoption', () => {
    document.body.dataset.yhStyle = 'terminal'
    expect(new ThemeRuntime(new Context(), stubConfigForm<ThemeSettings>().scope).getTheme().style).toBe('terminal')
    document.body.dataset.yhStyle = 'unknown'
    expect(new ThemeRuntime(new Context(), stubConfigForm<ThemeSettings>().scope).getTheme().style).toBe('default')
  })

  it('rejects an unsupported runtime style without publishing or persisting it', () => {
    const host = stubConfigForm<ThemeSettings>()
    const theme = new ThemeRuntime(new Context(), host.scope)
    const initial = theme.getTheme()
    expect(() => { theme.setStyle('unknown' as never) }).toThrow('not supported')
    expect(theme.getTheme()).toBe(initial)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('publishes the durable style before the shell mounts', () => {
    const row = bootThemeInjections('dark', 18, 'terminal')[1]
    if (row?.kind !== 'script') throw new Error('expected bootstrap script')
    runInNewContext(row.text, { document })
    expect(document.body.dataset.yhStyle).toBe('terminal')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('18px')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
  })
})
