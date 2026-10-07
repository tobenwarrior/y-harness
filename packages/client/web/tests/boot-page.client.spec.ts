// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BootPage } from '../src/boot-page.ts'

let originalLang: string | null
beforeEach(() => {
  originalLang = document.documentElement.getAttribute('lang')
  document.documentElement.lang = 'en'
  vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  document.body.innerHTML = ''
  if (originalLang === null) document.documentElement.removeAttribute('lang')
  else document.documentElement.setAttribute('lang', originalLang)
})

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.firstElementChild?.firstElementChild?.firstElementChild?.textContent).toBe('HARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it.each(['Y Harness', 'Atlas', '星图 $&'])('keeps the literal %s wordmark through progress, failure and retry', async (name) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', name)
    const { el, page } = mount()
    const wordmark = el.firstElementChild?.firstElementChild?.firstElementChild
    expect(wordmark?.textContent).toBe(name)
    expect(wordmark?.childElementCount).toBe(0)

    page.setTotal(2)
    page.setState('a', 'active')
    page.setState('b', 'loading')
    expect(el.textContent).toContain('Loading plugins…')
    expect(wordmark?.textContent).toBe(name)

    page.setState('b', 'failed')
    expect(el.textContent).toContain('Failed to load plugins')
    expect(wordmark?.textContent).toBe(name)

    const retry = vi.fn(async () => { throw new Error('retry failed') })
    page.fail('layout failed', retry)
    const button = el.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    expect(button?.textContent).toBe('Retry')
    expect(wordmark?.textContent).toBe(name)
    button?.click()
    expect(button?.disabled).toBe(true)
    expect(wordmark?.textContent).toBe(name)
    await vi.waitFor(() => { expect(el.textContent).toContain('retry failed') })
    expect(retry).toHaveBeenCalledOnce()
    expect(el.firstElementChild?.firstElementChild?.firstElementChild).toBe(wordmark)
    expect(wordmark?.textContent).toBe(name)
    expect(el.querySelector('[data-dsh-boot-retry]')?.textContent).toBe('Retry')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })

  it('keeps localized retry available while plugin locale services are absent', async () => {
    document.documentElement.lang = 'zh-CN'
    const { el, page } = mount()
    expect(el.textContent).toContain('正在加载插件')
    const retry = vi.fn(async () => { throw new Error('retry failed') })
    page.fail('layout failed', retry)
    const button = el.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    expect(button?.textContent).toBe('重试')
    button?.click()
    expect(button?.disabled).toBe(true)
    await vi.waitFor(() => { expect(el.textContent).toContain('retry failed') })
    expect(retry).toHaveBeenCalledOnce()
    expect(el.textContent).toContain('插件加载失败')
  })
})
