/** Built settings controls share radius and card materials across account, model, and plugin pages. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { AccountView } from '@yharness/deepseek-account/types'
import type {} from '@yharness/deepseek-account'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/settings-appearance', import.meta.url))

/** @param element - Rendered control or card. @returns Its visible geometry and material. */
function appearance(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      radius: style.borderRadius, border: style.borderTopWidth, stroke: style.borderTopColor,
      fill: style.backgroundColor, height: Math.round(node.getBoundingClientRect().height),
    }
  })
}

it('shares settings card materials and control sizes in both palettes', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.settings.mutate('ui-settings-account', [
    { op: 'set', path: ['step'], value: 'done' },
    { op: 'set', path: ['completion'], value: 'completed' },
  ])
  const account = scaffold.ctx.deepseekAccount
  const state: AccountView = {
    status: 'credential-stored', attempt: null,
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
  }
  // The Platform provider supplies synthetic identity and wallets; renderer, RPC, and settings remain real.
  const mocks = [
    vi.spyOn(account, 'getState').mockResolvedValue(state),
    vi.spyOn(account, 'getProfile').mockResolvedValue({
      status: 'ready', value: { id: null, name: 'Radius example', contact: 'r***@example.com', avatarUrl: null },
    }),
    vi.spyOn(account, 'getBalance').mockResolvedValue({
      status: 'ready', value: [{ currency: 'CNY', balance: '128.50' }],
      bonusWallets: [{ currency: 'CNY', balance: '12.00' }],
    }),
    vi.spyOn(account, 'watch').mockImplementation(async function* (signal) {
      yield state
      if (signal.aborted) return
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }),
  ]
  onTestFinished(() => { mocks.forEach((mock) => { mock.mockRestore() }) })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSettings(page, 'zh')
  const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}', exact: true })

  for (const [palette, label] of [['light', '\u{6D45}\u{8272}'], ['dark', '\u{6DF1}\u{8272}']] as const) {
    await dialog.getByRole('button', { name: '\u{5916}\u{89C2}', exact: true }).click()
    await dialog.getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(palette === 'dark')
    await dialog.getByRole('button', { name: '\u{901A}\u{7528}\u{8BBE}\u{7F6E}', exact: true }).click()
    const selector = await appearance(dialog.getByRole('button', { name: '\u{5DE5}\u{4F5C}\u{533A}\u{5185}\u{4FEE}\u{6539}', exact: true }))
    expect(selector.radius).toBe('12px')
    expect((await appearance(dialog)).radius).toBe('28px')

    await dialog.getByRole('button', { name: '\u{8D26}\u{53F7}\u{4E0E}\u{4F59}\u{989D}', exact: true }).click()
    const section = dialog.getByRole('region', { name: '\u{8D26}\u{53F7}\u{4E0E}\u{4F59}\u{989D}', exact: true })
    await expect.poll(() => section.innerText()).toContain('¥128.50')
    const cards = section.locator(':scope > div')
    expect(await cards.count()).toBe(2)
    const profile = await appearance(cards.nth(0))
    const balance = await appearance(cards.nth(1))
    const material = { radius: profile.radius, border: profile.border, stroke: profile.stroke, fill: profile.fill }
    expect(material.radius).toBe('20px')
    expect(material.fill).not.toBe('rgba(0, 0, 0, 0)')
    expect(balance).toMatchObject(material)
    const usage = await appearance(section.getByRole('link', { name: '\u{67E5}\u{8BE2}\u{7528}\u{91CF}', exact: true }))
    const topUp = await appearance(section.getByRole('link', { name: '\u{5145}\u{503C}', exact: true }))
    expect(usage).toMatchObject({ radius: '12px', height: 36 })
    expect(topUp).toMatchObject({ radius: '12px', height: 36 })
    await compareOrRefreshGolden(join(EXPECTED, 'account.expected.md'),
      await captureStableAria(page, 'section[aria-label="\u{8D26}\u{53F7}\u{4E0E}\u{4F59}\u{989D}"]', scaffold.workspaceCwd), webSnapshotMode())

    await dialog.getByRole('button', { name: '\u{5185}\u{7F6E}\u{63D2}\u{4EF6}', exact: true }).click()
    await dialog.getByRole('button', { name: /^\u5168\u5C40/ }).click()
    const plugin = dialog.locator('[data-plugin-scope="global"] [data-plugin-entry]').first()
    await plugin.waitFor()
    expect(await appearance(plugin)).toMatchObject(material)

    await dialog.getByRole('button', { name: 'Agent \u{9884}\u{8BBE}', exact: true }).click()
    const preset = dialog.locator('li').first()
    await preset.waitFor()
    expect((await appearance(preset)).radius).toBe('20px')

    await dialog.getByRole('button', { name: '\u{6A21}\u{578B}', exact: true }).click()
    await dialog.getByRole('button', { name: '\u{6DFB}\u{52A0}\u{6A21}\u{578B}\u{63D0}\u{4F9B}\u{5546}', exact: true }).click()
    const field = dialog.getByLabel('\u{63D0}\u{4F9B}\u{5546}', { exact: true })
    await field.waitFor()
    expect(await appearance(field)).toMatchObject({ radius: '12px', height: 32 })
    const save = await appearance(dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }))
    expect(save).toMatchObject({ radius: '12px', height: 36 })
    await compareOrRefreshGolden(join(EXPECTED, `${palette}.expected.md`),
      JSON.stringify({ card: material, selector, usage, topUp, save }, null, 2), webSnapshotMode())
    await dialog.getByRole('button', { name: '\u{53D6}\u{6D88}', exact: true }).click()
  }
})
